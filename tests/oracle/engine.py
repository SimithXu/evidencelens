"""EvidenceLens: deterministic, provenance-preserving review helpers.

This module does not establish authenticity or semantic entailment. Evidence
assertions are importer-supplied annotations, not facts discovered by an AI.
"""
from __future__ import annotations

from datetime import datetime
import hashlib
import json
import math
import re
import unicodedata
from pathlib import Path

MAX_BYTES = 1_000_000
MAX_RECORDS = 200
MAX_JSON_DEPTH = 40
MAX_JSON_NODES = 50000
KINDS = {'delivery', 'chat', 'contract', 'access_log', 'note'}
ASSERTIONS = {'seller_delivery_claim', 'buyer_nonreceipt', 'partial_delivery', 'buyer_acceptance', 'scope_agreement', ''}
WARNING = 'Exact quotations and hashes do not establish authenticity, completeness, or semantic support. All conclusions require human review.'


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _unique_pairs(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError('Duplicate JSON keys are not allowed.')
        obj[key] = value
    return obj


def _invalid_constant(value):
    raise ValueError('Non-finite JSON numbers are not allowed.')


def _decode(raw):
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_BYTES:
        raise ValueError('Import must be nonempty UTF-8 JSON, no larger than 1 MB.')
    try:
        text = raw.decode('utf-8', errors='strict')
        obj = json.loads(text, object_pairs_hook=_unique_pairs, parse_constant=_invalid_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError('Import must be valid UTF-8 JSON.') from exc
    except RecursionError as exc:
        raise ValueError(f'JSON nesting exceeds the maximum depth of {MAX_JSON_DEPTH}.') from exc
    if not isinstance(obj, dict):
        raise ValueError('JSON root must be an object.')
    stack, nodes = [(obj, 1)], 0
    while stack:
        value, depth = stack.pop()
        nodes += 1
        if depth > MAX_JSON_DEPTH or nodes > MAX_JSON_NODES:
            raise ValueError('JSON structure exceeds the supported depth or node limit.')
        if isinstance(value, dict):
            stack.extend((item, depth + 1) for pair in value.items() for item in pair)
        elif isinstance(value, list):
            stack.extend((item, depth + 1) for item in value)
        elif isinstance(value, float) and not math.isfinite(value):
            raise ValueError('Non-finite JSON numbers are not allowed.')
        elif isinstance(value, str):
            try:
                value.encode('utf-8', errors='strict')
            except UnicodeEncodeError as exc:
                raise ValueError('JSON strings must not contain unpaired Unicode surrogates.') from exc
    return obj, text


def _json_value_spans(text):
    """Index exact original value-token spans by structural path, not first match.

    Called only after bounded strict JSON decoding. Strings retain their original
    escape syntax and offsets always count Python Unicode codepoints.
    """
    decoder, spans = json.JSONDecoder(), {}

    def ws(index):
        while index < len(text) and text[index] in ' \t\r\n':
            index += 1
        return index

    def walk(index, path):
        index = ws(index)
        start = index
        if text[index] == '{':
            index = ws(index + 1)
            while text[index] != '}':
                key, index = decoder.raw_decode(text, index)
                index = ws(index)
                index = walk(index + 1, path + (key,))
                index = ws(index)
                if text[index] == ',':
                    index = ws(index + 1)
                else:
                    break
            index += 1
        elif text[index] == '[':
            index, entry = ws(index + 1), 0
            while text[index] != ']':
                index = walk(index, path + (entry,))
                entry += 1
                index = ws(index)
                if text[index] == ',':
                    index = ws(index + 1)
                else:
                    break
            index += 1
        else:
            _, index = decoder.raw_decode(text, index)
        spans[path] = (start, index)
        return index

    walk(0, ())
    return spans


def _string(value, field, *, required=False, limit=250):
    if value is None:
        value = ''
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ValueError(f'{field} must be a {"nonempty " if required else ""}string, maximum {limit} characters.')
    try:
        value.encode('utf-8', errors='strict')
    except UnicodeEncodeError as exc:
        raise ValueError(f'{field} contains an unpaired Unicode surrogate.') from exc
    return value


def _timestamp(value, field='occurred_at'):
    value = _string(value, field, limit=64)
    if value:
        try:
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})', value):
                raise ValueError()
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                raise ValueError()
        except ValueError as exc:
            raise ValueError(f'{field} must be an ISO-8601 timestamp with a timezone.') from exc
    return value


def _source(*, raw, original, filename, text, case_id, order_id, kind,
            occurred_at='', synthetic=False, label='', index=None, assertion='', provenance='user_import'):
    digest = hashlib.sha256(raw).hexdigest()
    identity = hashlib.sha256(_canonical([case_id, order_id, filename, digest, index, kind]).encode('utf-8')).hexdigest()
    return dict(source_id='src-' + identity[:24], sha256=digest, filename=filename,
                original_text=original, text=text, case_id=case_id, order_id=order_id,
                kind=kind, occurred_at=occurred_at, synthetic=synthetic,
                label=label or filename, entry_index=index, assertion=assertion,
                provenance=provenance, extraction='Original UTF-8 JSON' if index is None else f'JSON evidence[{index}].text',
                span_unit='Unicode codepoints')


def import_case(raw: bytes, name='dispute.json'):
    """Accept native PayPal dispute detail or the documented sanitized wrapper."""
    obj, original = _decode(raw)
    spans = _json_value_spans(original)
    name = _string(name, 'filename', required=True)
    dispute_path = ('dispute',) if 'dispute' in obj else ()
    dispute = obj.get('dispute', obj)
    if not isinstance(dispute, dict):
        raise ValueError('dispute must be an object.')
    dispute_id = _string(dispute.get('dispute_id'), 'dispute_id', required=True)
    transactions = dispute.get('disputed_transactions', [])
    if not isinstance(transactions, list) or any(not isinstance(t, dict) for t in transactions):
        raise ValueError('disputed_transactions must be an array of objects.')
    tx = transactions[0] if transactions else {}
    order = obj.get('order', {})
    capture = obj.get('capture', {})
    if not isinstance(order, dict) or not isinstance(capture, dict):
        raise ValueError('order and capture must be objects.')
    order_id = _string(order.get('id', obj.get('order_id', '')), 'order_id')
    amount = dispute.get('dispute_amount', tx.get('gross_amount', {'value': '', 'currency_code': ''}))
    if not isinstance(amount, dict):
        raise ValueError('dispute_amount must be an object.')
    value = _string(amount.get('value', ''), 'amount.value', limit=32)
    currency = _string(amount.get('currency_code', ''), 'amount.currency_code', limit=8)
    supplied_provenance = obj.get('provenance', {})
    if not isinstance(supplied_provenance, dict):
        raise ValueError('provenance must be an object.')
    is_historical = supplied_provenance.get('kind') == 'historical_sandbox_snapshot'
    provenance = {
        'kind': 'historical_sandbox_snapshot' if is_historical else 'user_import',
        'label': 'Historical Sandbox API snapshot · sanitized reconstruction' if is_historical else 'User-imported dispute JSON · not independently verified',
        'note': _string(supplied_provenance.get('note', ''), 'provenance.note', limit=2000),
        'environment': 'sandbox' if is_historical else 'unverified',
        'live': False,
    }
    result = dict(dispute_id=dispute_id, order_id=order_id,
                  capture_id=_string(capture.get('id', tx.get('seller_transaction_id', '')), 'capture_id'),
                  buyer_transaction_id=_string(tx.get('buyer_transaction_id', ''), 'buyer_transaction_id'),
                  amount=dict(value=value, currency_code=currency),
                  reason=_string(dispute.get('reason', ''), 'reason'),
                  status=_string(dispute.get('status', ''), 'status'),
                  dispute_state=_string(dispute.get('dispute_state', ''), 'dispute_state'),
                  dispute_life_cycle_stage=_string(dispute.get('dispute_life_cycle_stage', ''), 'dispute_life_cycle_stage'),
                  create_time=_timestamp(dispute.get('create_time', ''), 'create_time'),
                  order_create_time=_timestamp(order.get('create_time', ''), 'order.create_time'),
                  capture_create_time=_timestamp(capture.get('create_time', ''), 'capture.create_time'),
                  capture_status=_string(capture.get('status', ''), 'capture.status'),
                  item_type=_string(tx.get('item_type', ''), 'item_type'),
                  transaction_count=len(transactions), provenance=provenance,
                  native_unreviewed={key: dict(present=key in dispute,
                                               count=len(dispute[key]) if isinstance(dispute.get(key), list) else None,
                                               shape='array' if isinstance(dispute.get(key), list) else 'unrecognized',
                                               reviewed=False)
                                     for key in ('messages', 'evidences')})
    result['source'] = _source(raw=raw, original=original, filename=name, text=original,
                               case_id=dispute_id, order_id=order_id, kind='api_snapshot',
                               occurred_at=result['create_time'], label='Dispute API snapshot',
                               provenance=provenance['kind'])
    # Paths follow the exact precedence used in normalization above.
    field_paths = {key: dispute_path + (key,) for key in
                   ('dispute_id', 'reason', 'status', 'dispute_state', 'dispute_life_cycle_stage', 'create_time')}
    field_paths.update({
        'order_id': ('order', 'id') if 'id' in order else ('order_id',),
        'order_create_time': ('order', 'create_time'),
        'capture_id': ('capture', 'id') if 'id' in capture else dispute_path + ('disputed_transactions', 0, 'seller_transaction_id'),
        'capture_create_time': ('capture', 'create_time'),
        'capture_status': ('capture', 'status'),
        'buyer_transaction_id': dispute_path + ('disputed_transactions', 0, 'buyer_transaction_id'),
        'item_type': dispute_path + ('disputed_transactions', 0, 'item_type'),
        'messages': dispute_path + ('messages',), 'evidences': dispute_path + ('evidences',),
        'disputed_transactions': dispute_path + ('disputed_transactions',),
    })
    result['source']['field_spans'] = {}
    for field, path in field_paths.items():
        if path in spans:
            start, end = spans[path]
            result['source']['field_spans'][field] = dict(start=start, end=end, quote=original[start:end],
                json_pointer='/' + '/'.join(str(part).replace('~', '~0').replace('/', '~1') for part in path))
    return result


def import_evidence(raw: bytes, name: str, case: dict):
    obj, original = _decode(raw)
    if not isinstance(case, dict) or not isinstance(case.get('dispute_id'), str):
        raise ValueError('Import evidence requires a normalized case.')
    name = _string(name, 'filename', required=True)
    case_id = _string(obj.get('case_id'), 'case_id', required=True)
    order_id = _string(obj.get('order_id', ''), 'order_id')
    if case_id != case['dispute_id']:
        raise ValueError('Evidence belongs to a different dispute. Import was not applied.')
    if case.get('order_id') and order_id != case['order_id']:
        raise ValueError('Evidence order_id does not match this case. Import was not applied.')
    records = obj.get('evidence')
    if not isinstance(records, list) or not records or len(records) > MAX_RECORDS:
        raise ValueError('evidence must be an array containing 1–200 records.')
    sources = []
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise ValueError('Each evidence entry must be an object.')
        text = _string(record.get('text'), f'evidence[{index}].text', required=True, limit=50000)
        kind = record.get('kind', 'note')
        if not isinstance(kind, str) or kind not in KINDS:
            raise ValueError('kind must be delivery, chat, contract, access_log, or note.')
        assertion = record.get('assertion', '')
        if not isinstance(assertion, str) or assertion not in ASSERTIONS:
            raise ValueError('Unsupported assertion annotation.')
        synthetic = record.get('synthetic', False)
        if type(synthetic) is not bool:
            raise ValueError('synthetic must be true or false.')
        # Per-record scope labels cannot override bundle scope.
        if record.get('case_id', case_id) != case_id or record.get('order_id', order_id) != order_id:
            raise ValueError('An evidence entry has conflicting case/order scope.')
        label = _string(record.get('label', record.get('id', f'{kind.title()} {index + 1}')), 'label', required=True)
        sources.append(_source(raw=raw, original=original, filename=name, text=text,
                               case_id=case_id, order_id=order_id, kind=kind,
                               occurred_at=_timestamp(record.get('occurred_at', '')), synthetic=synthetic,
                               label=label, index=index, assertion=assertion,
                               provenance='synthetic_demo' if synthetic else 'user_import'))
    return sources


def _cite(source, quote=None):
    quote = source['text'] if quote is None else quote
    start = source['text'].find(quote)
    if not quote or start < 0:
        raise ValueError('Citation quote not present in source.')
    return dict(source_id=source['source_id'], quote=quote, start=start, end=start + len(quote))


def _field_cite(source, field):
    span = source.get('field_spans', {}).get(field)
    if span is None:
        raise ValueError('Normalized field has no matching original JSON path.')
    return dict(source_id=source['source_id'], start=span['start'], end=span['end'], quote=span['quote'])


def _validate_inputs(case, sources):
    if not isinstance(case, dict) or not isinstance(case.get('source'), dict):
        raise ValueError('A normalized case with its original source is required.')
    src = case['source']
    try:
        expected_case = import_case(src['original_text'].encode('utf-8'), src['filename'])
    except (KeyError, TypeError, AttributeError) as exc:
        raise ValueError('Invalid original case source.') from exc
    if expected_case != case:
        raise ValueError('Case data or source metadata changed. Re-import the original JSON.')
    if not isinstance(sources, list) or len(sources) > 1000:
        raise ValueError('sources must be an array of at most 1000 entries.')
    source_map = {src['source_id']: src}
    bundles = {}
    for source in sources:
        if not isinstance(source, dict):
            raise ValueError('Invalid source entry.')
        try:
            key = (source['filename'], source['original_text'])
            if key not in bundles:
                imported = import_evidence(source['original_text'].encode('utf-8'), source['filename'], case)
                bundles[key] = {s['source_id']: s for s in imported}
            expected = bundles[key].get(source['source_id'])
        except (KeyError, TypeError, AttributeError) as exc:
            raise ValueError('Invalid original evidence source.') from exc
        if expected != source:
            raise ValueError('Evidence text, hash, scope or metadata changed. Re-import its original JSON.')
        source_map[source['source_id']] = source
    missing = {sid for bundle in bundles.values() for sid in bundle if sid not in source_map}
    if missing:
        raise ValueError('Evidence bundle is incomplete: records from a retained original bundle were omitted. Re-import the entire bundle; selective source removal is not permitted.')
    return source_map


def analyze(case: dict, sources: list):
    """Build a cited timeline and conservative rules; never call this AI output."""
    source_map = _validate_inputs(case, sources)
    sources = sorted((s for sid, s in source_map.items() if sid != case['source']['source_id']), key=lambda s: s['source_id'])
    snapshot = case['source']
    timeline, findings, claims = [], [], []

    def event(id_, at, title, body, citations, kind='api_snapshot'):
        timeline.append(dict(id=id_, at=at, title=title, body=body, citations=citations, kind=kind))

    def finding(id_, severity, title, detail, citations=None):
        findings.append(dict(id=id_, severity=severity, title=title, detail=detail, citations=citations or []))

    def claim(id_, text, citations):
        claims.append(dict(id=id_, text=text, citations=citations, status='needs_review'))

    if case['order_create_time']:
        refs = [_field_cite(snapshot, 'order_create_time')]
        if case['order_id']:
            refs.append(_field_cite(snapshot, 'order_id'))
        event('order', case['order_create_time'], 'Order created', f"Order {case['order_id'] or '(not provided)'}. Imported snapshot; not a current status check.", refs)
    if case['capture_id']:
        refs = [_field_cite(snapshot, 'capture_id')]
        if case['capture_status']:
            refs.append(_field_cite(snapshot, 'capture_status'))
        if case['capture_create_time']:
            refs.append(_field_cite(snapshot, 'capture_create_time'))
        event('capture', case['capture_create_time'], 'Payment recorded', f"Capture {case['capture_id']} · {case['capture_status'] or 'status not provided'}. Payment is not proof of service delivery.", refs)
        claim('payment', f"The imported snapshot records seller transaction/capture {case['capture_id']}. A payment record alone does not establish service delivery.", refs)
    refs = [_field_cite(snapshot, 'dispute_id')]
    if case['reason']:
        refs.append(_field_cite(snapshot, 'reason'))
    if case['create_time']:
        refs.append(_field_cite(snapshot, 'create_time'))
    if case['status']:
        refs.append(_field_cite(snapshot, 'status'))
    event('dispute', case['create_time'], 'Dispute opened', f"{case['dispute_id']} · {case['reason'] or 'reason not provided'}. Current status in the imported snapshot: {case['status'] or 'unknown'}.", refs)
    claim('dispute', f"The imported dispute {case['dispute_id']} records reason {case['reason'] or '(not provided)'} and status {case['status'] or '(not provided)'}. This describes the imported record, not a current live status.", refs + ([_field_cite(snapshot, 'status')] if case['status'] else []))

    for source in sources:
        qualifier = 'SIMULATED' if source['synthetic'] else 'IMPORTED / UNVERIFIED'
        event(source['source_id'], source['occurred_at'], source['label'], f"{qualifier} · {source['text']}", [_cite(source)], source['kind'])
    annotated = {kind: [s for s in sources if s['assertion'] == kind] for kind in ASSERTIONS}
    delivered = annotated['seller_delivery_claim']
    nonreceipt = annotated['buyer_nonreceipt']
    partial = annotated['partial_delivery']
    acceptance = annotated['buyer_acceptance']
    agreement = annotated['scope_agreement']
    if delivered and (nonreceipt or partial):
        relevant = delivered + nonreceipt + partial
        finding('conflict-delivery', 'high', 'Delivery accounts conflict',
                'Importer annotations label a seller delivery claim alongside buyer non-receipt or partial-delivery evidence. These accounts are not reconciled. Annotation labels are not semantic verification.', [_cite(s) for s in relevant])
    if partial:
        finding('adverse-partial', 'high', 'Partial-delivery evidence must stay visible',
                'A record is explicitly annotated as partial delivery. Do not describe complete fulfillment without addressing it; the annotation itself requires review.', [_cite(s) for s in partial])
    if not acceptance:
        finding('gap-acceptance', 'medium', 'No acceptance record identified',
                'No imported record is annotated as buyer acceptance. This is a gap in the imported material, not proof that acceptance never happened.')
    if not agreement:
        finding('gap-scope', 'medium', 'Agreed service scope is missing',
                'No imported record is annotated as the agreed scope. Add the contract, deliverables and acceptance criteria if available.')
    if not any(s['kind'] == 'access_log' for s in sources):
        finding('gap-access', 'medium', 'Independent access or delivery receipt is missing',
                'No access_log record was imported. A seller message or generated link is not independent evidence the buyer could access the service.')
    if any(not s['occurred_at'] for s in sources):
        finding('gap-dates', 'medium', 'Some evidence has no timestamp',
                'Undated records are listed at the end of the timeline. Verify their actual event time before relying on sequence.', [_cite(s) for s in sources if not s['occurred_at']])
    if any(s['synthetic'] for s in sources):
        finding('synthetic-warning', 'high', 'Simulated material — never submit as real evidence',
                'This workspace contains synthetic examples. They demonstrate the workflow and cannot support a real merchant response.', [_cite(s) for s in sources if s['synthetic']])
    if not sources:
        finding('gap-evidence', 'high', 'No supporting evidence imported', 'The dispute snapshot is not proof of fulfillment. Import scoped service delivery and correspondence records.')
    if not case['order_id']:
        finding('gap-order', 'medium', 'Order mapping is unavailable', 'This JSON does not identify an order. Evidence is bound to the dispute ID only; review the transaction/order relationship manually.')
    if case['transaction_count'] > 1:
        finding('multi-transaction', 'high', 'Multiple transactions require manual review', 'The case summary displays the first transaction only. All transactions remain in the original JSON; do not assume all have been reviewed.', [_field_cite(snapshot, 'disputed_transactions')])
    for field, info in case['native_unreviewed'].items():
        if info['present'] and (info['count'] is None or info['count'] > 0):
            count = str(info['count']) if info['count'] is not None else 'an unrecognized container of'
            finding('unreviewed-native-' + field, 'high', f'Native PayPal {field} need manual review',
                    f'The original dispute JSON contains {count} {field}. They remain available in the original JSON but have not been extracted, classified or reviewed. No completeness claim is justified; import a verified scoped transcription if needed.',
                    [_field_cite(snapshot, field)])
    for annotation, label in [('seller_delivery_claim', 'A source annotated as a seller delivery claim states'),
                              ('buyer_nonreceipt', 'A source annotated as buyer non-receipt states'),
                              ('partial_delivery', 'Adverse material annotated as partial delivery states'),
                              ('buyer_acceptance', 'A source annotated as buyer acceptance states')]:
        for source in annotated[annotation]:
            prefix = '[SIMULATED — NOT SUBMITTABLE] ' if source['synthetic'] else '[IMPORTED — VERIFY] '
            claim('claim-' + source['source_id'], f'{prefix}{label}: “{source["text"]}”', [_cite(source)])
    timeline.sort(key=lambda e: (datetime.fromisoformat(e['at'].replace('Z', '+00:00')).timestamp() if e['at'] else float('inf'), e['id']))
    warnings = [WARNING, 'Rules use explicit import annotations, not an AI model. Unannotated records are preserved but not semantically classified.']
    return dict(timeline=timeline, findings=findings, claims=claims, mode='deterministic', warnings=warnings)



def _semantic_risk(text, citations, source_map):
    """A deliberately narrow safety tripwire, not an entailment classifier.

    Existing partial-delivery annotations plus unqualified complete-delivery
    language require fresh review. Only an explicit attributed, exact seller
    quote is exempted; generic paraphrases may be conservatively flagged.
    """
    partial = [s for s in source_map.values() if s.get('assertion') in {'partial_delivery', 'buyer_nonreceipt'}]
    if not partial:
        return None
    # Normalize compatibility glyphs and remove format controls for this bounded
    # tripwire only. Original text and citation spans are never normalized.
    lower = ''.join(c for c in unicodedata.normalize('NFKC', text) if unicodedata.category(c) != 'Cf').casefold()
    patterns = [
        r'\ball\s*(?:10|ten).{0,110}\b(?:deliver\w*|receiv\w*|fulfill\w*|complet\w*)',
        r'\b(?:all|every)\b.{0,110}\b(?:deliver\w*|receiv\w*|fulfill\w*|complet\w*)',
        r'\b(?:deliver\w*|receiv\w*|fulfill\w*|complet\w*)\b.{0,70}\b(?:all|every|100%)',
        r'\b(?:full(?:y)?|complete(?:ly)?|100%)\s+(?:deliver\w*|fulfill\w*|receiv\w*)',
        r'\b(?:delivery|fulfillment|fulfilment)\b.{0,35}\b(?:complete|full|100%)',
        r'\b(?:deliver\w*|receiv\w*|fulfill\w*)\s+in\s+full\b',
        r'\b(?:10\s*(?:of|out of|/)\s*10|ten\s+(?:of|out of)\s+ten)\b.{0,70}\b(?:deliver\w*|receiv\w*|complet\w*)',
        r'(?:全部|全数|全數|所有|完全|100%).{0,30}(?:交付|送达|送達|收到|完成|履行)',
        r'(?:交付|送达|送達|收到|完成|履行).{0,30}(?:全部|全数|全數|所有|10[／/]10)',
    ]
    if not any(re.search(pattern, lower, flags=re.DOTALL) for pattern in patterns):
        return None
    stripped = re.sub(r'^\[(?:SIMULATED — NOT SUBMITTABLE|IMPORTED — VERIFY)\]\s*', '', text).strip()
    for citation in citations:
        source = source_map[citation['source_id']]
        if source.get('assertion') != 'seller_delivery_claim' or citation['quote'] != source['text']:
            continue
        exact = source['text']
        prefixes = [
            'A source annotated as a seller delivery claim states:',
            'The seller states:', 'The seller claims:', 'Seller states:', 'Seller claims:',
            '卖家声称：', '卖家表示：', '賣家聲稱：', '賣家表示：',
        ]
        if any(stripped.startswith(prefix) and stripped[len(prefix):].strip().strip('“”"「」‘’') == exact
               for prefix in prefixes):
            return None
    return {
        'code': 'complete_delivery_vs_partial_record',
        'severity': 'high',
        'detail': 'Complete-delivery language conflicts with an imported partial-delivery or buyer non-receipt annotation. This claim is not established as source-supported; its review status was reset. Resolve the discrepancy or write a precise attributed account.',
        'source_ids': [s['source_id'] for s in partial],
        'method': 'conservative lexical rule; not semantic entailment',
    }


def verify_export(case: dict, sources: list, claims: list):
    source_map = _validate_inputs(case, sources)
    if not isinstance(claims, list) or len(claims) > 500:
        raise ValueError('claims must be an array of at most 500 claims.')
    exported = []
    semantic_risks = []
    seen_ids = set()
    for c in claims:
        if not isinstance(c, dict):
            raise ValueError('Invalid claim.')
        cid = _string(c.get('id'), 'claim.id', required=True)
        if cid in seen_ids:
            raise ValueError('Duplicate claim IDs.')
        seen_ids.add(cid)
        text = _string(c.get('text'), 'claim.text', required=True, limit=100000)
        status = c.get('status', 'needs_review')
        if not isinstance(status, str) or status not in {'needs_review', 'reviewed', 'unsupported'}:
            raise ValueError('Unknown review status.')
        citations = c.get('citations', [])
        if not isinstance(citations, list) or len(citations) > 1000:
            raise ValueError('Invalid citations list.')
        if not citations and status != 'unsupported':
            raise ValueError('Uncited claims must be explicitly marked unsupported.')
        checked = []
        for citation in citations:
            if not isinstance(citation, dict):
                raise ValueError('Invalid citation.')
            source_id = citation.get('source_id')
            if not isinstance(source_id, str):
                raise ValueError('Citation source_id must be a string.')
            source = source_map.get(source_id)
            if source is None:
                raise ValueError('Citation source is missing or outside the current case.')
            start, end, quote = citation.get('start'), citation.get('end'), citation.get('quote')
            if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(source['text']):
                raise ValueError('Citation has an invalid Unicode codepoint span.')
            if not isinstance(quote, str) or source['text'][start:end] != quote:
                raise ValueError('Citation quote does not exactly match its source span.')
            checked.append(dict(source_id=source['source_id'], start=start, end=end, quote=quote))
        risk = _semantic_risk(text, checked, source_map)
        item = dict(id=cid, text=text, status='needs_review' if risk else status, citations=checked)
        if risk:
            item['semantic_risk'] = risk
            semantic_risks.append(dict(claim_id=cid, **risk))
        exported.append(item)
    synthetic = any(s['synthetic'] for s in source_map.values())
    unresolved = [dict(finding, status='unresolved') for finding in analyze(case, sources)['findings']]
    coverage = []
    for source in source_map.values():
        if source.get('assertion') not in {'partial_delivery', 'buyer_nonreceipt'}:
            continue
        citations = [(c['id'], citation) for c in exported for citation in c['citations']
                     if citation['source_id'] == source['source_id']]
        spans = sorted((citation['start'], citation['end']) for _, citation in citations)
        covered_to = 0
        for start, end in spans:
            if start > covered_to:
                break
            covered_to = max(covered_to, end)
        complete = covered_to == len(source['text'])
        coverage.append(dict(source_id=source['source_id'], assertion=source['assertion'],
                             status='fully_cited' if complete else ('partially_cited' if citations else 'omitted'),
                             claim_ids=sorted({cid for cid, _ in citations}),
                             coverage_complete=complete))
    blockers = [dict(code=f['id'], severity=f['severity'], detail=f['detail']) for f in unresolved]
    omitted = [entry for entry in coverage if not entry['coverage_complete']]
    for entry in omitted:
        blockers.append(dict(code='adverse-evidence-not-fully-cited', severity='high', source_id=entry['source_id'],
                             detail='Known adverse evidence is absent or only partially quoted in the draft. Review cannot be considered complete.'))
    if semantic_risks:
        blockers.append(dict(code='semantic-risk', severity='high', detail='One or more claims triggered the bounded semantic-risk guard.'))
    claims_reviewed = bool(exported) and all(c['status'] == 'reviewed' for c in exported)
    return dict(schema_version=1, application='EvidenceLens MVP', case_id=case['dispute_id'],
                order_id=case['order_id'], span_unit='Unicode codepoints', case=case,
                sources=list(source_map.values()), claims=exported, mode='human_review_draft',
                submission_permitted=False, contains_synthetic=synthetic,
                citation_integrity_verified=True, semantic_support_verified=False, semantic_risks=semantic_risks,
                claims_reviewed=claims_reviewed, review_complete=claims_reviewed and not blockers,
                unresolved_findings=unresolved, review_blockers=blockers, adverse_coverage=coverage,
                coverage_method='Full-source citation coverage, not semantic acknowledgment or completeness beyond the current packet.',
                warnings=[WARNING, 'Review export only. No PayPal submission or refund was performed.',
                          *(['Known adverse evidence was omitted or incompletely cited; review is not complete.'] if omitted else []),
                          'Completeness applies only to the current supplied packet. Entire previously imported bundles cannot be tracked by this stateless server.',
                          *(['Complete-delivery language was flagged against partial-delivery evidence; affected claims require review and must not be treated as established.'] if semantic_risks else []),
                          'Synthetic content cannot be submitted as real evidence.' if synthetic else 'User-imported evidence is not independently authenticated.'])


def load_demo():
    fixtures = Path(__file__).parent / 'fixtures'
    case = import_case((fixtures / 'sandbox-dispute.json').read_bytes(), 'sandbox-dispute.json')
    sources = import_evidence((fixtures / 'simulated-evidence.json').read_bytes(), 'simulated-evidence.json', case)
    return dict(case=case, sources=sources, analysis=analyze(case, sources))
