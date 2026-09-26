import { describe, it, expect } from 'vitest'
import { classifyOfferTarget } from '../src/commands/offers.js'

describe('ow offers list target', () => {
  it('routes inscription ids, addresses and slugs', () => {
    expect(classifyOfferTarget('6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0')).toBe('inscription')
    expect(classifyOfferTarget('bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3')).toBe('address')
    expect(classifyOfferTarget('bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l')).toBe('address')
    expect(classifyOfferTarget('bitmap')).toBe('collection')
    expect(classifyOfferTarget('quantum_cats')).toBe('collection')
    expect(classifyOfferTarget('tap-DMT-NAT')).toBe('collection')
  })
})
