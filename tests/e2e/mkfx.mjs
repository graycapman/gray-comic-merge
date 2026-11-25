import zlib from 'node:zlib'; import fs from 'node:fs'; import path from 'node:path';
const out = process.argv[2];
function crc(buf){let c,t=[];for(let n=0;n<256;n++){c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0}let r=0xffffffff;for(const b of buf)r=t[(r^b)&255]^(r>>>8);return(r^0xffffffff)>>>0}
function chunk(type,data){const l=Buffer.alloc(4);l.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type),data]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([l,td,c])}
function png(w,h,rgb){const raw=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++){raw[y*(w*3+1)]=0;for(let x=0;x<w;x++){const o=y*(w*3+1)+1+x*3;raw[o]=rgb[0];raw[o+1]=rgb[1];raw[o+2]=rgb[2]}}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])}
let i=0;
const put=(p,n)=>{fs.mkdirSync(path.dirname(path.join(out,p)),{recursive:true});fs.writeFileSync(path.join(out,p),png(60,80,[(n*37)%255,(n*91)%255,(n*17)%255]))};
for (const ch of ['Chapter 1','Chapter 2','Chapter 10']) for (let p=1;p<=3;p++) put(`Comic/${ch}/${String(p).padStart(3,'0')}.png`, ++i);
for (let p=1;p<=4;p++) put(`loose/x${p}.png`, 50+p);
for (let p=1;p<=3;p++) put(`cbzsrc/${String(p).padStart(3,'0')}.png`, 80+p);
fs.writeFileSync(path.join(out,'Comic/notes.txt'),'hi');
