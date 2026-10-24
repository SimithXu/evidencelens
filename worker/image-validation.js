// Local bytes only. Structural validation is not authenticity or visual truth.
export const MAX_IMAGE_BYTES=262144;
export class ImageValidationError extends Error{constructor(message,status=400){super(message);this.name='ImageValidationError';this.status=status;}}
const bad=()=>{throw new ImageValidationError('Image is corrupt, truncated, or an unsupported PNG/JPEG encoding.');};
const u32=(b,i)=>new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(i);
const dimensions=(w,h)=>{if(!w||!h||w>4096||h>4096||w*h>4000000)throw new ImageValidationError('Image dimensions exceed the bounded limit (4096 per side and 4 million pixels).',413);return {width:w,height:h};};
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
async function png(b){if(b.length<57||[137,80,78,71,13,10,26,10].some((v,i)=>b[i]!==v))bad();let at=8,frame,parts=[],partLen=0,ended=false,sawPalette=false,idatEnded=false;
 while(at<b.length){if(at+12>b.length)bad();const n=u32(b,at);if(n>b.length-at-12)bad();const type=String.fromCharCode(...b.slice(at+4,at+8));if(!/^[A-Za-z]{4}$/.test(type)||crc32(b.subarray(at+4,at+8+n))!==u32(b,at+8+n))bad();const data=b.subarray(at+8,at+8+n);
 if(!frame&&type!=='IHDR')bad();if(type==='IHDR'){if(frame||n!==13)bad();const dims=dimensions(u32(data,0),u32(data,4)),depth=data[8],color=data[9],valid={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};if(!valid[color]?.includes(depth)||data[10]!==0||data[11]!==0||data[12]!==0)bad();frame={...dims,depth,color};}
 else if(type==='PLTE'){if(partLen||!n||n%3||n>768)bad();sawPalette=true;}
 else if(type==='IDAT'){if(idatEnded)bad();if(frame.color===3&&!sawPalette)bad();parts.push(data);partLen+=n;}
 else if(type==='IEND'){if(n||!partLen)bad();at+=12;ended=true;break;}
 else {if(partLen)idatEnded=true;if(type[0]===type[0].toUpperCase())bad();}
 at+=n+12;
 }
 if(!ended||at!==b.length||!frame)bad();const channels={0:1,2:3,3:1,4:2,6:4}[frame.color],row=Math.ceil(frame.width*frame.depth*channels/8),expected=(row+1)*frame.height;if(expected>16777216)throw new ImageValidationError('Decoded PNG exceeds the safe image limit.',413);
 const compressed=new Uint8Array(partLen);let pos=0;for(const part of parts){compressed.set(part,pos);pos+=part.length;}
 let reader;try{reader=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();let count=0;while(true){const {value,done}=await reader.read();if(done)break;if(count+value.length>expected){await reader.cancel();bad();}for(let i=0;i<value.length;i++)if((count+i)%(row+1)===0&&value[i]>4)bad();count+=value.length;}if(count!==expected)bad();}catch(error){try{await reader?.cancel();}catch{}if(error instanceof ImageValidationError)throw error;bad();}return {width:frame.width,height:frame.height};
}
function jpeg(b){if(b.length<20||b[0]!==255||b[1]!==216)bad();let at=2,frame,sawScan=false,sawDQT=false,sawDHT=false,entropy=0;
 while(at<b.length){if(b[at++]!==255)bad();while(b[at]===255)at++;if(at>=b.length)bad();const marker=b[at++];if(marker===217){if(!frame||!sawScan||!sawDQT||!sawDHT||!entropy||at!==b.length)bad();return frame;}if(marker===216||marker===0||marker===1||(marker>=208&&marker<=215))bad();if(at+2>b.length)bad();const n=(b[at]<<8)|b[at+1];if(n<2||at+n>b.length)bad();const end=at+n;
 if(marker===192||marker===194){if(frame||n<11||b[at+2]!==8)bad();const components=b[at+7];if(![1,3,4].includes(components)||n!==8+3*components)bad();frame=dimensions((b[at+5]<<8)|b[at+6],(b[at+3]<<8)|b[at+4]);}
 else if(marker>=192&&marker<=207&&![196,200,204].includes(marker))bad();
 if(marker===219){if(n<67)bad();sawDQT=true;}if(marker===196){if(n<19)bad();sawDHT=true;}
 at=end;
 if(marker===218){if(!frame||n<8)bad();const components=b[end-n+2];if(!components||components>4||n!==6+2*components)bad();sawScan=true;while(at<b.length){if(b[at]!==255){entropy++;at++;continue;}if(at+1>=b.length)bad();let next=at+1;while(b[next]===255)next++;if(next>=b.length)bad();if(b[next]===0){entropy++;at=next+1;continue;}if(b[next]>=208&&b[next]<=215){at=next+1;continue;}break;}}
 }bad();
}
export async function validateImage(body){if(!body||typeof body!=='object'||Array.isArray(body))throw new ImageValidationError('Provide a local PNG or JPEG file.');const {name,mime_type,image_base64}=body;if(typeof name!=='string'||!name.trim()||Array.from(name).length>250||/[\uD800-\uDFFF]/u.test(name))throw new ImageValidationError('Image filename must contain 1–250 valid Unicode characters.');if(!['image/png','image/jpeg'].includes(mime_type))throw new ImageValidationError('Only local PNG and JPEG screenshots are supported.');if(typeof image_base64!=='string'||!image_base64||image_base64.length>4*Math.ceil(MAX_IMAGE_BYTES/3))throw new ImageValidationError('Image must be nonempty and at most 256 KiB.',413);if(image_base64.length%4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image_base64))throw new ImageValidationError('Provide canonical base64 image bytes, not an image URL.');let binary;try{binary=atob(image_base64);}catch{bad();}if(btoa(binary)!==image_base64)throw new ImageValidationError('Image base64 must use canonical encoding.');const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));if(bytes.length>MAX_IMAGE_BYTES)throw new ImageValidationError('Image must be at most 256 KiB.',413);const dims=await(mime_type==='image/png'?png(bytes):jpeg(bytes));const digest=await crypto.subtle.digest('SHA-256',bytes),image_sha256=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');return {name,mime_type,image_base64,image_sha256,byte_length:bytes.length,...dims};}
