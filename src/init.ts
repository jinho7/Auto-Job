import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { paths } from './paths';
import { loadSchema } from './profile/schema';
import { ProfileStore } from './profile/store';

/** settings.yaml 과 profile/me/ 가 없으면 만든다. 있는 파일은 건드리지 않는다. */
export function ensureInitialized(): { settingsCreated: boolean; profileCreated: string[] } {
  const settingsCreated = !existsSync(paths.settings);
  if (settingsCreated) cpSync(paths.settingsExample, paths.settings);
  const profileCreated = new ProfileStore(paths.profileMe, loadSchema(paths.profileSchema)).initFiles();
  mkdirSync(paths.runs, { recursive: true });
  return { settingsCreated, profileCreated };
}
