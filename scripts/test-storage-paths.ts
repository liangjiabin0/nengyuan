import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isPathUnderAllowedRoots} from '../src/lib/bundle-store';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai4es-path-check-'));
try {
 const physical=path.join(root,'physical');const outside=path.join(root,'outside');
 fs.mkdirSync(physical);fs.mkdirSync(outside);fs.writeFileSync(path.join(physical,'paper.pdf'),'fixture');fs.writeFileSync(path.join(outside,'secret.txt'),'fixture');
 const alias=path.join(root,'alias');fs.symlinkSync(physical,alias,process.platform==='win32'?'junction':'dir');
 fs.symlinkSync(outside,path.join(physical,'escape'),process.platform==='win32'?'junction':'dir');
 assert(isPathUnderAllowedRoots(path.join(physical,'paper.pdf'),alias));
 assert(isPathUnderAllowedRoots(path.join(alias,'paper.pdf'),alias));
 assert(!isPathUnderAllowedRoots(path.join(alias,'escape','secret.txt'),alias));
 assert(!isPathUnderAllowedRoots(path.join(outside,'secret.txt'),alias));
 console.log('SHARED_STORAGE_AND_SYMLINK_ESCAPE_PASS');
}finally{fs.rmSync(root,{recursive:true,force:true});}
