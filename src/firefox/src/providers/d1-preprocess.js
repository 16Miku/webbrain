export const f32=Math.fround;
export function pyJSON(value) {
  if(Array.isArray(value)) return '['+value.map(pyJSON).join(', ')+']';
  if(value!==null && typeof value==='object') return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+': '+pyJSON(v)).join(', ')+'}';
  if(typeof value==='number') {
    if(!Number.isFinite(value)) throw new Error('D1 JSON numbers must be finite');
    if(!Number.isInteger(value)&&Math.abs(value)<1e-4) return value.toExponential().replace(/e([+-])(\d+)$/,(all,sign,digits)=>'e'+sign+digits.padStart(2,'0'));
  }
  return JSON.stringify(value);
}
export function roundEven(x) {
  const n=Math.floor(x),r=x-n;
  return r===0.5 ? n+(n%2) : Math.round(x);
}
const escape=s=>s.replace(/<\|([A-Za-z0-9_]+)\|>/g,'<\u00a6$1\u00a6>');
const criterion=v=>typeof v==='string'?v:pyJSON(v);
export function renderOptions(q,image=false) {
  if(q.type==='choice') return Object.entries(q.criteria).map(([k,v])=>v==null||v===''?k:`${k}: ${criterion(v)}`);
  if(q.type==='score') return q.criteria.map((c,i)=>`level ${i}: ${criterion(c)}`);
  const c=q.criteria&&Object.keys(q.criteria).length?q.criteria:(image?{false:'no',true:'yes'}:{});
  const no=Object.hasOwn(c,'false')?c.false:c.no,yes=Object.hasOwn(c,'true')?c.true:c.yes;
  return ['false: '+(no!=null&&no!==''?criterion(no):'no, the statement does not hold'),'true: '+(yes!=null&&yes!==''?criterion(yes):'yes, the statement holds')];
}
export function encode(tokenizer,state,q,maxLen,image=false) {
  if(!['choice','noul','score'].includes(q.type)||typeof q.instructions!=='string')throw new Error('Invalid question type or instructions');
  if(q.type==='choice'&&(!q.criteria||Array.isArray(q.criteria)||Object.keys(q.criteria).length<2))throw new Error('A choice requires at least two named criteria');
  if(q.type==='score'&&(!Array.isArray(q.criteria)||q.criteria.length<2||q.criteria.length>10))throw new Error('A score requires 2 to 10 levels');
  if(q.type==='noul'&&q.criteria!=null&&(Array.isArray(q.criteria)||typeof q.criteria!=='object'))throw new Error('noul criteria must be an object');
  const id=s=>tokenizer.convert_tokens_to_ids(s);
  const enc=s=>Array.from(tokenizer.encode(escape(s),{add_special_tokens:false}));
  const options=renderOptions(q,image);
  const budget=Math.max(96,Math.min(options.length*24+32,Math.floor(maxLen/2)));
  const per=Math.max(2,Math.floor((budget-3*options.length)/options.length));
  const question=[id('<|reserved_8|>'),...enc(q.instructions)].slice(0,Math.max(16,budget));
  const markers=[];
  for(const option of options) {
    markers.push(question.length+1);
    question.push(id('<|reserved_9|>'),id('<|mask|>'),...enc(' '+option).slice(0,per),id('<|reserved_10|>'));
  }
  question.push(id('<|reserved_11|>'));
  const room=Math.max(0,maxLen-question.length-2);
  const stateIds=[id('<|reserved_7|>'),...enc(typeof state==='string'?state:pyJSON(state)).slice(0,room)];
  const ids=[tokenizer.bos_token_id,...stateIds,...question].slice(0,maxLen);
  const positions=markers.map(m=>m+1+stateIds.length);
  if(positions.at(-1)>=maxLen) throw new Error('Options do not fit in context');
  return {input_ids:ids,markers:positions};
}
export function temperature(q,config,image=false) {
  if(image) return 1;
  const n=q.type==='noul'?2:Object.keys(q.criteria).length;
  const key=q.type+':'+(n<=2?'2':n<=5?'3-5':n<=10?'6-10':'11+');
  return config.temperatures[key] ?? config.temperatures[q.type] ?? 1;
}
export function layout(width,height,ratios) {
  if(Math.min(width,height)<1) throw new Error('Empty image');
  let h=Math.max(32,roundEven(height/32)*32),w=Math.max(32,roundEven(width/32)*32);
  if(h*w>262144) {const beta=Math.sqrt(height*width/262144);h=Math.max(32,Math.floor(height/beta/32)*32);w=Math.max(32,Math.floor(width/beta/32)*32);}
  else if(h*w<65536) {const beta=Math.sqrt(65536/(height*width));h=Math.ceil(height*beta/32)*32;w=Math.ceil(width*beta/32)*32;}
  const tiled=Math.max(16,roundEven(height/32)*32)*Math.max(16,roundEven(width/32)*32)>524288;
  let grid=[1,1];
  if(tiled) {let best=Infinity;for(const r of ratios) {const diff=Math.abs(width/height-r[0]/r[1]);if(diff<best || (diff===best && width*height>0.5*512*512*r[0]*r[1])) {grid=r;best=diff;}}}
  return {grid,thumbnail:[h,w],tiled};
}
function resizeWeights(input,output) {
  const scale=input/output,support=Math.max(1,scale),rows=[];
  let largest=0;
  for(let i=0;i<output;i++) {
    const center=scale*(i+0.5);
    const start=Math.max(0,Math.trunc(center-support+0.5));
    const end=Math.min(input,Math.trunc(center+support+0.5));
    let weights=Array.from({length:end-start},(_,j)=>Math.max(0,1-Math.abs((j+start-center+0.5)/support)));
    const total=weights.reduce((a,b)=>a+b,0);
    weights=weights.map(w=>w/total);
    largest=Math.max(largest,...weights);
    rows.push({start,weights});
  }
  let precision=0;
  for(;precision<22;precision++) if(Math.trunc(0.5+largest*2**(precision+1))>=32768) break;
  const unit=2**precision;
  for(const row of rows) row.weights=row.weights.map(w=>Math.trunc(0.5+w*unit));
  return {rows,unit};
}
// Torch's uint8 antialias path rounds fixed-point horizontal and vertical passes.
export function resizeRGB(rgb,width,height,newWidth,newHeight) {
  let temp=rgb;
  if(width!==newWidth) {
    const {rows,unit}=resizeWeights(width,newWidth);
    temp=new Uint8Array(newWidth*height*3);
    for(let y=0;y<height;y++) for(let x=0;x<newWidth;x++) for(let c=0;c<3;c++) {
      const row=rows[x];let sum=unit/2;
      for(let j=0;j<row.weights.length;j++) sum+=rgb[(y*width+row.start+j)*3+c]*row.weights[j];
      temp[(y*newWidth+x)*3+c]=Math.max(0,Math.min(255,Math.floor(sum/unit)));
    }
  }
  if(height===newHeight) return temp;
  const {rows,unit}=resizeWeights(height,newHeight),out=new Uint8Array(newWidth*newHeight*3);
  for(let y=0;y<newHeight;y++) for(let x=0;x<newWidth;x++) for(let c=0;c<3;c++) {
    const row=rows[y];let sum=unit/2;
    for(let j=0;j<row.weights.length;j++) sum+=temp[((row.start+j)*newWidth+x)*3+c]*row.weights[j];
    out[(y*newWidth+x)*3+c]=Math.max(0,Math.min(255,Math.floor(sum/unit)));
  }
  return out;
}
export async function imageInputs(url,ratios) {
  const blob=await (await fetch(url)).blob(),bitmap=await createImageBitmap(blob,{colorSpaceConversion:'none'});
  const {width,height}=bitmap;
  const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(bitmap,0,0);
  const rgba=ctx.getImageData(0,0,width,height).data,rgb=new Uint8Array(width*height*3);
  for(let i=0;i<width*height;i++) rgb.set(rgba.subarray(i*4,i*4+3),i*3);
  bitmap.close();
  const plan=layout(width,height,ratios),crops=[];
  if(plan.tiled) {
    const [gw,gh]=plan.grid,big=resizeRGB(rgb,width,height,gw*512,gh*512);
    for(let r=0;r<gh;r++) for(let c=0;c<gw;c++) {
      const pixels=new Uint8Array(512*512*3);
      for(let y=0;y<512;y++) pixels.set(big.subarray(((r*512+y)*gw*512+c*512)*3,((r*512+y)*gw*512+c*512+512)*3),y*512*3);
      crops.push({rgb:pixels,h:512,w:512});
    }
  }
  const [h,w]=plan.thumbnail;
  crops.push({rgb:resizeRGB(rgb,width,height,w,h),h,w});
  const pixels=new Float32Array(crops.length*1024*768),mask=new Int32Array(crops.length*1024),shapes=[];
  crops.forEach((crop,i)=>{
    const ph=crop.h/16,pw=crop.w/16;
    shapes.push([ph,pw]);mask.fill(1,i*1024,i*1024+ph*pw);
    for(let r=0;r<ph;r++) for(let c=0;c<pw;c++) for(let y=0;y<16;y++) for(let x=0;x<16;x++) for(let ch=0;ch<3;ch++) {
      const v=crop.rgb[((r*16+y)*crop.w+c*16+x)*3+ch];
      pixels[(i*1024+r*pw+c)*768+(y*16+x)*3+ch]=f32(f32(v-127.5)/127.5);
    }
  });
  return {plan,pixels,mask,shapes};
}
export function positionMatrix(h,w) {
  const matrix=new Float32Array(1024*256);
  const weights=(input,output)=>Array.from({length:output},(_,i)=>{
    const scale=f32(input/output),support=Math.max(1,scale),center=f32(scale*f32(i+0.5));
    const start=Math.max(0,Math.trunc(f32(f32(center-support)+0.5))),end=Math.min(input,Math.trunc(f32(f32(center+support)+0.5)));
    const inv=scale>=1?f32(1/scale):1;
    const a=[];let sum=0;
    for(let j=start;j<end;j++){const v=f32(Math.max(0,f32(1-Math.abs(f32(f32(f32(j-center)+0.5)*inv)))));a.push([j,v]);sum=f32(sum+v);}
    return a.map(([j,v])=>[j,f32(v/sum)]);
  });
  const wy=weights(16,h),wx=weights(16,w);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const row=(y*w+x)*256;
    for(const [iy,vy] of wy[y]) for(const [ix,vx] of wx[x]) matrix[row+iy*16+ix]=f32(vy*vx);
  }
  for(let i=h*w;i<1024;i++) matrix.set(matrix.subarray(0,256),i*256);
  return matrix;
}
const bits=new DataView(new ArrayBuffer(4));
export function toHalf(v) {
  bits.setFloat32(0,v,true);const x=bits.getUint32(0,true),sign=(x>>>16)&0x8000,exponent=(x>>>23)&255,mantissa=x&0x7fffff;
  if(exponent===255) return sign|0x7c00|(mantissa?0x200:0);
  const e=exponent-127;
  if(e>15) return sign|0x7c00;
  if(e < -25) return sign;
  const shift=e < -14 ? -e-1 : 13;
  const m=e < -14 ? mantissa|0x800000 : mantissa;
  const base=m>>>shift,rem=m&(2**shift-1),half=2**(shift-1);
  const rounded=base+(rem>half || (rem===half && (base&1))?1:0);
  return sign | (e < -14 ? rounded : ((e+15)<<10)+rounded);
}
export function fromHalf(x) {
  const sign=x&0x8000?-1:1,e=(x>>10)&31,m=x&1023;
  return e===0?sign*m*2**-24:e===31?(m?NaN:sign*Infinity):sign*(1+m/1024)*2**(e-15);
}
export const halfArray=a=>Uint16Array.from(a,toHalf);
