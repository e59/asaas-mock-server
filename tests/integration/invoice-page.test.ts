/**
 * A página pública `/i/{id}` — o link que `invoiceUrl` carrega.
 *
 * Duas regressões moram aqui:
 *
 *   1. `invoiceUrl` já foi hardcoded `https://localhost/i/...`, ignorando
 *      `publicBaseUrl` — todo o resto do simulador montava URLs públicas a
 *      partir da config e payments era o único módulo que não. A integração
 *      exibia o link, o dev clicava e caía num 404 do roteador local.
 *   2. A página em si: resumo read-only da cobrança, pública (sem
 *      `access_token`), porque no Asaas real o link de pagamento é público.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { createHarness, type Harness } from '../helpers/harness.ts'

let h: Harness
afterEach(() => h?.close())

const get = (app: Harness['app'], path: string) =>
  app.app.handle(new Request(`http://localhost${path}`))

describe('página de cobrança /i/{id}', () => {
  it('invoiceUrl sai da publicBaseUrl, não de um localhost fixo', async () => {
    h = await createHarness({ publicBaseUrl: 'https://mock.example' })

    const customer = await h.api.call('create-new-customer', {
      body: { name: 'Fulano', cpfCnpj: '24971563792' },
    })
    const pay = await h.api.call('create-new-payment', {
      body: { customer: customer.body.id, billingType: 'PIX', value: 100, dueDate: '2026-01-10' },
    })

    const numeric = String(pay.body.id).replace('pay_', '')
    expect(pay.body.invoiceUrl).toBe(`https://mock.example/i/${numeric}`)
  })

  it('serve o resumo HTML da cobrança sem access_token', async () => {
    h = await createHarness()

    const customer = await h.api.call('create-new-customer', {
      body: { name: 'Fulano', cpfCnpj: '24971563792' },
    })
    const pay = await h.api.call('create-new-payment', {
      body: {
        customer: customer.body.id,
        billingType: 'UNDEFINED',
        value: 120.5,
        dueDate: '2026-01-10',
        description: 'Contribuição Associativa',
      },
    })

    const numeric = String(pay.body.id).replace('pay_', '')
    const res = await get(h.app, `/i/${numeric}`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')

    const html = await res.text()
    expect(html).toContain('R$ 120,50')
    expect(html).toContain('Contribuição Associativa')
    expect(html).toContain('Pendente')
    expect(html).toContain('10/01/2026')
  })

  it('id inexistente devolve 404', async () => {
    h = await createHarness()

    const res = await get(h.app, '/i/naoexiste')

    expect(res.status).toBe(404)
  })
})
