import { CredentialStore } from '../src/store.js';
import { Secrets } from '../src/errors.js';
const store = new CredentialStore(process.argv[2]!, 'mock-host', new Secrets(), process.argv[3]!);
for (let index = 0; index < 8; index++) {
  for (let attempt = 0; ; attempt++) {
    try {
      await store.withLock(async tx => {
        const value = (await tx.load())!; value.expiresAt++;
        await new Promise(resolve => setTimeout(resolve, 5)); await tx.save(value);
      });
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== 'AUTH_BUSY' || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
}
