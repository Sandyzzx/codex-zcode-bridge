// Offline fixture: exactly one length-prefixed UTF-8 JSON frame per stream.
export function encodeFrame(value, max=16384) {
  const body=Buffer.from(JSON.stringify(value),'utf8');
  if(body.length===0||body.length>max) throw Error('frame_size');
  const prefix=Buffer.alloc(4);prefix.writeUInt32BE(body.length);return Buffer.concat([prefix,body]);
}
export class SingleFrame {
  #parts=[]; #length=0; #limit; #done=false;
  constructor(limit=16384){this.#limit=limit;}
  push(chunk){
    if(this.#done)throw Error('extra_frame');
    if(!Buffer.isBuffer(chunk))throw Error('invalid_chunk');
    this.#length+=chunk.length;
    if(this.#length>this.#limit+4)throw Error('frame_size');
    this.#parts.push(chunk);
    const data=Buffer.concat(this.#parts,this.#length);
    if(data.length<4)return;
    const n=data.readUInt32BE(0);
    if(n===0||n>this.#limit)throw Error('frame_size');
    if(data.length>n+4)throw Error('extra_frame');
    if(data.length<n+4)return;
    this.#done=true;this.#parts=[];
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(4));}catch{throw Error('invalid_utf8');}
    try{return JSON.parse(text);}catch{throw Error('invalid_json');}
  }
  end(){if(!this.#done)throw Error('incomplete_frame');}
}
export function validatePacket(packet,scope,now=Date.now()){
  if(!packet||typeof packet!=='object'||!Number.isFinite(packet.expiresAt)||packet.expiresAt<=now)throw Error('expired_or_invalid');
  if(typeof packet.id!=='string'||!packet.id||typeof packet.jwt!=='string'||!packet.jwt)throw Error('invalid_packet');
  for(const k of ['account','provider','model','task','attempt','session','turn'])if(packet.scope?.[k]!==scope[k]||scope[k]===undefined||scope[k]===null||scope[k]==='')throw Error('scope_mismatch');
  return packet;
}
