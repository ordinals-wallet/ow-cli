import { createRequire } from 'node:module'

export async function promptPassword(message = 'Enter password: '): Promise<string> {
  const { default: inquirer } = await import('inquirer')
  const { password } = await inquirer.prompt([
    {
      type: 'password',
      name: 'password',
      message,
      mask: '*',
    },
  ])
  return password
}

export async function promptConfirm(message: string): Promise<boolean> {
  const { default: inquirer } = await import('inquirer')
  const { confirmed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message,
      default: false,
    },
  ])
  return confirmed
}

export async function requireConfirm(message: string): Promise<void> {
  const confirmed = await promptConfirm(message)
  if (!confirmed) {
    console.log('Cancelled.')
    throw { cancelled: true }
  }
}

export async function promptInput(message: string): Promise<string> {
  const { default: inquirer } = await import('inquirer')
  const { value } = await inquirer.prompt([
    {
      type: 'input',
      name: 'value',
      message,
    },
  ])
  return value
}
