import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash, paddleLayout} from './regions.mjs';

export async function extractPaddle(sourceId, file, signal, onProgress=()=>{}) {
  const dir=await mkdtemp(join(tmpdir(),'margin-paddle-'));
  const project=fileURLToPath(new URL('../extraction/',import.meta.url));
  const output=join(dir,'regions.json');
  try {
    await new Promise((resolve,reject)=>{
      const child=spawn('uv',['run','--project',project,'--extra','paddle','python',join(project,'paddle_extract.py'),file,output],{stdio:['ignore','pipe','pipe'],signal});
      let log='';
      const record=chunk=>{ log=(log+chunk.toString()).slice(-3000); onProgress(log.split('\n').filter(Boolean).at(-1)?.slice(0,200)||'Running PaddleOCR'); };
      child.stdout.on('data',record); child.stderr.on('data',record);
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('PaddleOCR exceeded the 30-minute intake limit.'));},30*60*1000);
      child.on('error',e=>{clearTimeout(timer);reject(new Error(e.name==='AbortError'?'Intake cancelled.':`Cannot start PaddleOCR: ${e.message}. Install uv and see extraction setup in README.`));});
      child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`PaddleOCR failed (${code}). ${log.slice(-1800)}`));});
    });
    signal?.throwIfAborted();
    return paddleLayout(sourceId,hash(new Uint8Array(await readFile(file))),JSON.parse(await readFile(output,'utf8')));
  } finally {await rm(dir,{recursive:true,force:true});}
}
