import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const installer=resolve('scripts/install-hooks.mjs');
const guard=resolve('scripts/require-container.sh');
function run(command,args,cwd,extra={}) {
  return spawnSync(command,args,{cwd,encoding:'utf8',...extra});
}
function checked(command,args,cwd){const r=run(command,args,cwd);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const container=run('sh',[guard],process.cwd()).status===0;
async function localInstaller(root) {
  const path=join(root,'scripts','install-hooks.mjs');await mkdir(join(root,'scripts'),{recursive:true});
  await writeFile(path,await readFile(installer));return path;
}

test('container guard uses actual environment rather than flags',()=>{
  const result=run('sh',[guard],process.cwd(),{env:{...process.env,ENCBIRD_IN_DOCKER:'1',CI:'true',REMOTE_CONTAINERS:'true'}});
  assert.equal(result.status,container?0:1);
});

test('hook installation preserves the effective security runner and existing hook, arguments and stdin',async t=>{
  const root=await mkdtemp(join(tmpdir(),'encbird-hook-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  checked('git',['init','-q',root],root);
  const previousConfig=run('git',['config','--get','core.hooksPath'],root).stdout;
  const path=join(root,'.git','hooks','pre-push');const observed=join(root,'hook-observed');
  const original='#!/bin/sh\nprintf "%s\\n" "$1" "$2" > "'+observed+'"\ncat >> "'+observed+'"\nexit 23\n';
  await writeFile(path,original);await chmod(path,0o755);
  const install=await localInstaller(root);
  checked(process.execPath,[install],root);checked(process.execPath,[install],root);
  assert.equal(run('git',['config','--get','core.hooksPath'],root).stdout,previousConfig);
  assert.equal(await readFile(join(root,'.git/hooks/pre-push.encbird-previous'),'utf8'),original);
  const refs='refs/heads/main aaaa refs/heads/main bbbb\n';
  const result=run(path,['origin','https://github.com/haandol/encbird-plugin.git'],root,{input:refs});
  if(container){
    assert.equal(result.status,23);
    assert.equal(await readFile(observed,'utf8'),'origin\nhttps://github.com/haandol/encbird-plugin.git\n'+refs);
  }else{
    assert.equal(result.status,1);await assert.rejects(readFile(observed),{code:'ENOENT'});
  }
});

test('conflicting prior-hook backup is not overwritten',async t=>{
  const root=await mkdtemp(join(tmpdir(),'encbird-hook-conflict-'));t.after(()=>rm(root,{recursive:true,force:true}));
  checked('git',['init','-q',root],root);
  const directory=join(root,'.git/hooks');await mkdir(directory,{recursive:true});
  const path=join(directory,'pre-push'),backup=join(directory,'pre-push.encbird-previous');
  await writeFile(path,'original hook');await writeFile(backup,'older hook');
  assert.notEqual(run(process.execPath,[await localInstaller(root)],root).status,0);
  assert.equal(await readFile(path,'utf8'),'original hook');assert.equal(await readFile(backup,'utf8'),'older hook');
});

test('an installed repository hook blocks a real host push before refs change', {skip:container},async t=>{
  const root=await mkdtemp(join(tmpdir(),'encbird-host-push-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const work=join(root,'work'),remote=join(root,'remote.git');
  checked('git',['init','-q',work],root);checked('git',['init','--bare','-q',remote],root);
  await writeFile(join(work,'fixture'),'synthetic hook check\n');checked('git',['add','fixture'],work);
  checked('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','test: fixture'],work);
  checked(process.execPath,[await localInstaller(work)],work);
  const result=run('git',['push',remote,'HEAD:refs/heads/main'],work);
  assert.notEqual(result.status,0);assert.match(result.stderr,/EncBird Plugin pushes must run inside/);
  assert.equal(run('git',['--git-dir',remote,'show-ref'],root).stdout,'');
});

test('credential relay keeps the token in the child environment and rejects missing input', {skip:!container},async t=>{
  const root=await mkdtemp(join(tmpdir(),'encbird-relay-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dir=join(root,'scripts');await mkdir(dir);
  for(const name of ['require-container.sh','release-with-token.sh'])await writeFile(join(dir,name),await readFile(resolve('scripts',name)));
  await writeFile(join(dir,'publish-release.sh'),`#!/bin/sh
python3 -c 'import os,sys,json,hashlib; print(json.dumps({"args":sys.argv[1:],"digest":hashlib.sha256(os.environ["GH_TOKEN"].encode()).hexdigest(),"legacy":os.getenv("GITHUB_TOKEN"),"debug":os.getenv("GH_DEBUG")}))' "$@"
`);
  const secret='synthetic-publication-credential';
  const args=['publish','0.1.1','a'.repeat(40),'b'.repeat(64),'--check'];
  const result=run('sh',[join(dir,'release-with-token.sh'),...args],root,{input:secret+'\n',env:{...process.env,GITHUB_TOKEN:'unrelated-fixture',GH_DEBUG:'api'}});
  assert.equal(result.status,0,result.stderr);
  assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
  const output=JSON.parse(result.stdout);
  assert.deepEqual(output.args,args.slice(1));assert.equal(output.legacy,null);assert.equal(output.debug,null);
  const {createHash}=await import('node:crypto');assert.equal(output.digest,createHash('sha256').update(secret).digest('hex'));
  const missing=run('sh',[join(dir,'release-with-token.sh'),...args],root,{input:''});
  assert.equal(missing.status,1);assert.match(missing.stderr,/No GitHub credential/);
});


test('hook installation refuses another repository without altering its hook',async t=>{
  const root=await mkdtemp(join(tmpdir(),'encbird-other-repository-'));t.after(()=>rm(root,{recursive:true,force:true}));
  checked('git',['init','-q',root],root);
  const path=join(root,'.git/hooks/pre-push');await writeFile(path,'original other-repo hook');
  const result=run(process.execPath,[installer],root);
  assert.notEqual(result.status,0);assert.match(result.stderr,/another repository is not modified/);
  assert.equal(await readFile(path,'utf8'),'original other-repo hook');
});
