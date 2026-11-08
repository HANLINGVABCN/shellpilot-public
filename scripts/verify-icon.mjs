import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
const png=fs.readFileSync('build/icon.png');
assert.equal(png.readUInt32BE(16),1024);assert.equal(png.readUInt32BE(20),1024);
const compressed=[];
for(let offset=8;offset<png.length;) {
  const size=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8);
  if(type==='IDAT')compressed.push(png.subarray(offset+8,offset+8+size));
  offset+=size+12;
}
const raw=zlib.inflateSync(Buffer.concat(compressed));
const colorAt=(x,y)=>{
  x=Math.floor(x*1024/120);y=Math.floor(y*1024/120);
  assert.equal(raw[y*(1024*4+1)],0,'Generated PNG uses unfiltered RGBA rows');
  return [...raw.subarray(y*(1024*4+1)+1+x*4,y*(1024*4+1)+1+x*4+4)];
};
assert.deepEqual(colorAt(60,20),[229,168,90,255],'Supplied amber color');
for(const [x,y] of [[46,51],[80,51],[60,86]])assert.deepEqual(colorAt(x,y),[24,24,27,255],'Both eyes and cursor use the supplied charcoal');
assert.equal(colorAt(0,0)[3],0,'Rounded corners stay transparent');
assert.deepEqual(colorAt(60,65),[229,168,90,255]);
console.log('PASS: supplied SVG avatar geometry, colors, alpha and 1024px icon output');
