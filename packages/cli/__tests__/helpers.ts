import { program } from '../src/index.js'

export async function runCommand(args: string[]): Promise<void> {
  await program.parseAsync(['node', 'ow', ...args])
}
