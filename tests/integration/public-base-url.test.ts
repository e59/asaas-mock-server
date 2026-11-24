/**
 * O override de `publicBaseUrl` em runtime — o endpoint que o script de
 * `ddev share` do central-do-associado chama quando sobe o túnel deste
 * simulador. Sem ele, toda `invoiceUrl` nasceria apontando para o
 * `*.ddev.site:45445` local, morta para quem está do outro lado do túnel.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { createHarness, type Harness } from '../helpers/harness.ts'

let h: Harness
afterEach(() => h?.close())

const get = (h: Harness) =>
  h.app.app.handle(new Request('http://localhost/_admin/config/public-base-url'))

const set = (h: Harness, url: unknown) =>
  h.app.app.handle(
    new Request('http://localhost/_admin/config/public-base-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }),
  )

describe('/_admin/config/public-base-url', () => {
  it('expõe o valor vigente', async () => {
    h = await createHarness({ publicBaseUrl: 'https://antes.example' })
    const res = await get(h)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).publicBaseUrl).toBe('https://antes.example')
  })

  it('troca o base em runtime e a cobrança seguinte já nasce com ele', async () => {
    h = await createHarness({ publicBaseUrl: 'https://antes.example' })

    const res = await set(h, 'https://tunnel.example/')
    expect(res.status).toBe(200)
    // A barra final é descartada: `${base}/i/${id}` montaria `...//i/`.
    expect(((await res.json()) as any).publicBaseUrl).toBe('https://tunnel.example')

    const customer = await h.api.call('create-new-customer', {
      body: { name: 'Fulano', cpfCnpj: '24971563792' },
    })
    const pay = await h.api.call('create-new-payment', {
      body: { customer: customer.body.id, billingType: 'PIX', value: 100, dueDate: '2026-01-10' },
    })
    const numeric = String(pay.body.id).replace('pay_', '')
    expect(pay.body.invoiceUrl).toBe(`https://tunnel.example/i/${numeric}`)
  })

  it('aceita só URL absoluta http(s)', async () => {
    h = await createHarness()
    for (const url of ['não-é-url', 'ftp://arquivo.example']) {
      const res = await set(h, url)
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).errors[0].code).toBe('invalid_url')
    }
    // E não mudou nada.
    expect(((await (await get(h)).json()) as any).publicBaseUrl).toBe('https://sandbox.asaas.com')
  })
})
