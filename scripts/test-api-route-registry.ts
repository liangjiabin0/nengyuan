import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
const walk=(dir:string):string[]=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
const registry=fs.readFileSync('server/api/routes.ts','utf8');
const source=ts.createSourceFile('routes.ts',registry,ts.ScriptTarget.Latest,true);
const imports=new Set<string>();
function collectImports(node:ts.Node){
  if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){
    const argument=node.arguments[0];
    if(argument&&ts.isStringLiteral(argument))imports.add(argument.text);
  }
  ts.forEachChild(node,collectImports);
}
collectImports(source);
const files=walk('src/app/api').filter(f=>f.endsWith('route.ts'));
for(const file of files){const normalized=file.replaceAll('\\','/').replace(/\.ts$/,'');assert.ok(imports.has('../../'+normalized),'Unregistered API route: '+file);}
console.log(`API registry PASS: ${files.length} route modules`);
