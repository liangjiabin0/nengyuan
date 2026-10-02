import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const issues:string[]=[];
for(const [name,cmd] of Object.entries(pkg.scripts) as [string,string][]){for(const ref of cmd.matchAll(/(?:scripts|server)\/[\w/.-]+\.(?:m?js|ts|ps1|py|sh)/g))if(!fs.existsSync(ref[0]))issues.push(`${name}: missing ${ref[0]}`);}
for(const f of files.filter(f=>f.endsWith('.sh')))if(fs.readFileSync(f,'utf8').includes('\r\n'))issues.push(`CRLF shell: ${f}`);
for(const f of ['tools/ppt-native/build.mjs','.opencode/skills/shared-two-slide-paper-ppt-codegen/scripts/build_two_slide_deck.mjs'])if(!fs.existsSync(path.resolve(f)))issues.push(`Missing builder: ${f}`);
console.log(JSON.stringify({platform:process.platform,issues},null,2));if(issues.length)process.exitCode=1;
