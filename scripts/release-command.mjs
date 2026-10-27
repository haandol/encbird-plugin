import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [mode,...args]=process.argv.slice(2);
if (!['check','push','publish'].includes(mode) || args.length!==3) {
  console.error('Usage: npm run release:check|release:push|release:publish -- VERSION FULL_COMMIT_SHA ZIP_SHA256');
  process.exitCode=2;
} else {
  const script=fileURLToPath(new URL('./publish-release.sh',import.meta.url));
  const result=spawnSync('bash',[script,...args,`--${mode}`],{stdio:'inherit'});
  process.exitCode=result.status??1;
}
