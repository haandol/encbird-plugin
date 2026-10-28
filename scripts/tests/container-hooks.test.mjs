import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readlink, lstat, rm, chmod, mkdir, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { publicationCredentialNames, receiptPath, verifyReceipt } from '../check-source.mjs';
import { fixture, updates, run, checked } from './check-fixture.mjs';
const installer=resolve('scripts/install-hooks.mjs');
const guard=resolve('scripts/require-container.sh');
const container=run('sh',[guard],process.cwd()).status===0;
async function localInstaller(root) {
  const path=join(root,'scripts','install-hooks.mjs');await mkdir(join(root,'scripts'),{recursive:true});
  await writeFile(path,await readFile(installer));
  await writeFile(join(root,'scripts/check-source.mjs'),await readFile(resolve('scripts/check-source.mjs')));return path;
}

test('container guard uses actual environment rather than flags',()=>{
  const result=run('sh',[guard],process.cwd(),{env:{...process.env,ENCBIRD_IN_DOCKER:'1',CI:'true',REMOTE_CONTAINERS:'true'}});
  assert.equal(result.status,container?0:1);
});

test('Git dispatch follows static hook delegation while preserving signing and prior-hook args, stdin and rejection', {skip:!container}, async t=>{
  const f=await fixture(t);const {root}=f;
  const verification=f.check(['push']);assert.equal(verification.status,0,verification.stdout+verification.stderr);
  const security=join(f.base,'security-hooks');await mkdir(security);
  const config={'core.hooksPath':security,'commit.gpgSign':'true','tag.gpgSign':'true','gpg.program':'fixture-signer','user.signingkey':'fixture-signing-key'};
  for(const [key,value] of Object.entries(config))f.git('config',key,value);
  const path=join(root,'.git','hooks','pre-push');const observed=join(f.base,'hook-observed');
  const original='#!/bin/sh\nprintf "%s\\n" "$1" "$2" > "'+observed+'"\ncat >> "'+observed+'"\nexit 23\n';
  await writeFile(path,original);await chmod(path,0o755);
  await symlink(path,join(security,'pre-push'));
  const install=await localInstaller(root);
  checked(process.execPath,[install],root);checked(process.execPath,[install],root);
  for(const [key,value] of Object.entries(config))assert.equal(f.git('config','--get',key),value);
  assert.equal(await readlink(join(security,'pre-push')),path);
  assert.equal(await readFile(join(root,'.git/hooks/pre-push.encbird-previous'),'utf8'),original);
  const refs=updates(f.git('rev-parse','HEAD'));
  await writeFile(f.log,'');
  const result=f.push(refs,{remoteUrl:'https://example.invalid/repo with space.git',env:{GH_TOKEN:'synthetic-authenticated-push'}});
  assert.equal(result.status,23,result.stdout+result.stderr);
  assert.equal(await readFile(observed,'utf8'),'origin\nhttps://example.invalid/repo with space.git\n'+refs);
  assert.deepEqual(await f.commands(),[]);
});

test('an opaque effective security hook stops installation before any hook, backup or config mutation',async t=>{
  const f=await fixture(t);const security=join(f.base,'security-hooks');await mkdir(security);
  const observed=join(f.base,'security-was-executed');
  const runner=`#!/bin/sh\nprintf touched > '${observed}'\n`;
  await writeFile(join(security,'pre-push'),runner,{mode:0o755});
  f.git('config','core.hooksPath',security);
  const local=join(f.root,'.git/hooks/pre-push');await writeFile(local,'original repository hook');
  const before=f.git('config','--local','--list');
  const result=run(process.execPath,[join(f.root,'scripts/install-hooks.mjs')],f.root);
  assert.notEqual(result.status,0);assert.match(result.stderr,/does not statically delegate/);
  assert.equal(f.git('config','--local','--list'),before);
  assert.equal(await readFile(local,'utf8'),'original repository hook');
  assert.equal(await readFile(join(security,'pre-push'),'utf8'),runner);
  await assert.rejects(lstat(join(f.root,'.git/hooks/pre-push.encbird-previous')),{code:'ENOENT'});
  await assert.rejects(lstat(observed),{code:'ENOENT'});
});

test('a repository hooks directory symlink never redirects installation into a shared security directory',async t=>{
  const f=await fixture(t);const shared=join(f.base,'shared-security-hooks');await mkdir(shared);
  const original='#!/bin/sh\nexit 17\n';await writeFile(join(shared,'pre-push'),original,{mode:0o755});
  const hooks=join(f.root,'.git/hooks');await rename(hooks,`${hooks}.original`);await symlink(shared,hooks,'dir');
  const before=f.git('config','--local','--list');
  const result=run(process.execPath,[join(f.root,'scripts/install-hooks.mjs')],f.root);
  assert.notEqual(result.status,0);assert.match(result.stderr,/linked or shared hook directories are not modified/);
  assert.equal(await readFile(join(shared,'pre-push'),'utf8'),original);
  assert.equal(await readlink(hooks),shared);assert.equal(f.git('config','--local','--list'),before);
  await assert.rejects(lstat(join(shared,'pre-push.encbird-previous')),{code:'ENOENT'});
});

test('a dangling static delegation is installed at its repository target and used by Git', {skip:!container},async t=>{
  const f=await fixture(t);const security=join(f.base,'delegating-hooks');await mkdir(security);
  const target=join(f.root,'.git/hooks/pre-push');await symlink(target,join(security,'pre-push'));
  f.git('config','core.hooksPath',security);await f.install();
  const verified=f.check(['push']);assert.equal(verified.status,0,verified.stdout+verified.stderr);
  await writeFile(f.log,'');
  const result=f.push(updates(f.git('rev-parse','HEAD')),{env:{GH_TOKEN:'synthetic-present-credential'}});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(await readlink(join(security,'pre-push')),target);assert.deepEqual(await f.commands(),[]);
});

test('authenticated Git dispatch removes publication and Node preload credentials before verifier and prior test children', {skip:!container},async t=>{
  const f=await fixture(t);const prior=join(f.root,'.git/hooks/pre-push');
  await writeFile(prior,'#!/bin/sh\ncat >/dev/null\nnpm test\n',{mode:0o755});await chmod(prior,0o755);await f.install();
  const verified=f.check(['push']);assert.equal(verified.status,0,verified.stdout+verified.stderr);
  await writeFile(f.log,'');
  const npmConfig=join(f.base,'npm-user.conf');await writeFile(npmConfig,'');
  const preload=join(f.base,'preload.cjs');const observed=join(f.base,'preload-executed');
  await writeFile(preload,`require('node:fs').writeFileSync(${JSON.stringify(observed)}, 'unexpected preload');\n`);
  const token='synthetic-publication-token-never-log';
  const env={...Object.fromEntries(publicationCredentialNames.map(name=>[name,token])),NODE_OPTIONS:`--require=${preload}`,NODE_PATH:'/synthetic/preload-path',NPM_CONFIG_USERCONFIG:npmConfig};
  const result=f.push(updates(f.git('rev-parse','HEAD')),{env});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.ok(!result.stdout.includes(token)&&!result.stderr.includes(token));
  const commands=await f.commands();assert.equal(commands.length,1);assert.deepEqual(commands[0].args,['test']);
  assert.deepEqual(commands[0].credentials,[]);assert.equal(commands[0].nodeOptions,null);assert.equal(commands[0].nodePath,null);
  await assert.rejects(lstat(observed),{code:'ENOENT'});
  assert.equal(env.GH_TOKEN,token,'The Git caller retains its own publication credentials');
});

test('an ordinary token-free push runs exact-source checks before approving its receipt', {skip:!container}, async t=>{
  const f=await fixture(t);await f.install();
  const head=f.git('rev-parse','HEAD');const result=f.push(updates(head));
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal((await verifyReceipt(f.root)).commit,head);
  const commands=await f.commands();
  assert.deepEqual(commands[0].args,['ci','--ignore-scripts','--no-audit','--no-fund']);
  assert(commands.some(command=>command.args.includes('test:eval')));
  assert(commands.some(command=>command.args.includes('validate:docs')));
  assert(commands.every(command=>command.credentials.length===0));
});

test('authenticated pushes reject missing or stale receipts without running npm or leaking the token', {skip:!container}, async t=>{
  const f=await fixture(t);await f.install();
  const secret='ghp_synthetic_present_credential';
  let result=f.push(updates(f.git('rev-parse','HEAD')),{env:{GH_TOKEN:secret}});
  assert.notEqual(result.status,0);assert.match(result.stderr,/No matching verification receipt/);
  assert(!result.stdout.includes(secret)&&!result.stderr.includes(secret));
  assert.deepEqual(await f.commands(),[]);
  const verified=f.check(['push']);assert.equal(verified.status,0,verified.stdout+verified.stderr);
  await writeFile(f.log,'');
  await writeFile(join(f.root,'source.txt'),'new committed source\n');f.git('commit','-am','test: change source');
  result=f.push(updates(f.git('rev-parse','HEAD')),{env:{GITHUB_TOKEN:secret}});
  assert.notEqual(result.status,0);assert.match(result.stderr,/No matching verification receipt/);
  assert.deepEqual(await f.commands(),[]);
});

test('a matching receipt allows multiple refs and annotated tags for exactly one checked commit', {skip:!container}, async t=>{
  const f=await fixture(t);await f.install();
  f.git('branch','review');f.git('tag','-a','v0.0.0-fixture','-m','fixture annotated tag');
  const head=f.git('rev-parse','HEAD');const tag=f.git('rev-parse','refs/tags/v0.0.0-fixture');
  const verified=f.check(['push']);assert.equal(verified.status,0,verified.stdout+verified.stderr);
  await writeFile(f.log,'');
  const input=updates(head)+updates(head,'refs/heads/review')+updates(tag,'refs/tags/v0.0.0-fixture');
  const result=f.push(input,{env:{GH_TOKEN:'synthetic-present-credential'}});
  assert.equal(result.status,0,result.stdout+result.stderr);assert.deepEqual(await f.commands(),[]);
});

test('a multi-ref push containing another commit fails instead of checking only HEAD', {skip:!container}, async t=>{
  const f=await fixture(t);await f.install();
  const earlier=f.git('rev-parse','HEAD');f.git('branch','earlier');f.git('commit','--allow-empty','-m','test: later source commit');
  const head=f.git('rev-parse','HEAD');
  const verified=f.check(['push']);assert.equal(verified.status,0,verified.stdout+verified.stderr);
  await writeFile(f.log,'');
  const result=f.push(updates(head)+updates(earlier,'refs/heads/earlier'),{env:{GH_TOKEN:'synthetic-present-credential'}});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Multiple refs must all resolve to the current checked commit/);
  assert.deepEqual(await f.commands(),[]);
});

test('source changes by a previous hook fail the final receipt check', {skip:!container}, async t=>{
  const f=await fixture(t);
  const previous=join(f.root,'.git/hooks/pre-push');
  await writeFile(previous,`#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' changed > '${f.root}/source.txt'\n`,{mode:0o755});
  await chmod(previous,0o755);await f.install();
  const verified=f.check(['push']);assert.equal(verified.status,0,verified.stdout+verified.stderr);
  await writeFile(f.log,'');
  const result=f.push(updates(f.git('rev-parse','HEAD')),{env:{GH_TOKEN:'synthetic-present-credential'}});
  assert.notEqual(result.status,0);assert.match(result.stderr,/clean committed source/);
  assert.deepEqual(await f.commands(),[]);
});

test('linked-worktree Git environment cannot make fixture checks inspect the caller repository', {skip:!container}, async t=>{
  const f=await fixture(t);const linked=join(f.base,'linked');
  f.git('worktree','add','-q','-b','linked',linked);
  const gitDir=resolve(f.root,checked('git',['-C',linked,'rev-parse','--git-dir'],f.root));
  const env={...f.env,GIT_DIR:gitDir,GIT_COMMON_DIR:join(f.root,'.git'),GIT_WORK_TREE:linked,GIT_INDEX_FILE:join(gitDir,'index')};
  checked(process.execPath,[join(linked,'scripts/install-hooks.mjs')],linked,{env});
  const head=checked('git',['rev-parse','HEAD'],linked);
  const refs=join(f.base,'linked-refs');await writeFile(refs,updates(head,'refs/heads/linked'));
  const result=run('git',['hook','run',`--to-stdin=${refs}`,'pre-push','--','origin','https://example.invalid/fixture.git'],linked,{env});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const commands=await f.commands();assert(commands.length>0);
  assert(commands.every(command=>command.gitDir===null&&command.gitIndex===null));
  assert.equal((await verifyReceipt(linked)).commit,head);
  await assert.rejects(readFile(receiptPath(f.root,head)),{code:'ENOENT'});
});

test('deletion-only updates still reach the previous hook with the original stdin', {skip:!container}, async t=>{
  const f=await fixture(t);const observed=join(f.base,'deletion-input');
  const previous=join(f.root,'.git/hooks/pre-push');
  await writeFile(previous,`#!/bin/sh\ncat > '${observed}'\n`,{mode:0o755});await chmod(previous,0o755);await f.install();
  const input=`(delete) ${'0'.repeat(40)} refs/heads/old ${f.git('rev-parse','HEAD')}\n`;
  const result=f.push(input,{env:{GH_TOKEN:'synthetic-present-credential'}});
  assert.equal(result.status,0,result.stderr);assert.equal(await readFile(observed,'utf8'),input);
  assert.deepEqual(await f.commands(),[]);
});

test('upgrading the owned v1 guard preserves its original prior hook',async t=>{
  const f=await fixture(t);const path=join(f.root,'.git/hooks/pre-push');
  const previous=join(f.root,'.git/hooks/pre-push.encbird-previous');
  await writeFile(path,'#!/bin/sh\n# EncBird Docker-only pre-push v1\nexit 0\n');
  await writeFile(previous,'previous security hook\n');await f.install();
  assert.match(await readFile(path,'utf8'),/^#!\/bin\/sh\n# EncBird Docker-only pre-push v3\n/);
  assert.equal(await readFile(previous,'utf8'),'previous security hook\n');
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
  checked('git',['config','core.hooksPath',join(work,'.git/hooks')],work);
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
