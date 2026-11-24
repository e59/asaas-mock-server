/**
 * A página pública de cobrança — `GET /i/{id}`.
 *
 * É o link que a API devolve em `invoiceUrl` e que integrações exibem como
 * "Pagar". No Asaas real abre um checkout com Pix/boleto/cartão; aqui é um
 * RESUMO READ-ONLY: o propósito do simulador é ver o dinheiro andar, e o
 * pagamento em si é simulado no painel (ou via
 * `POST /v3/payments/{id}/receiveInCash`, como a API manda).
 *
 * Página pública de propósito: no Asaas real quem tem o link paga — ela não
 * pede `access_token`, não expõe chaves e não muta estado.
 */
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import type { AppContext } from '../../core/context.ts'
import { payments } from '../../db/schema/index.ts'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendente',
  RECEIVED: 'Recebida',
  RECEIVED_IN_CASH: 'Recebida em dinheiro',
  CONFIRMED: 'Confirmada',
  OVERDUE: 'Vencida',
  REFUNDED: 'Estornada',
  CHARGEBACK_REQUESTED: 'Contestada',
}

const STATUS_COLOR: Record<string, string> = {
  RECEIVED: '#2f9e44',
  RECEIVED_IN_CASH: '#2f9e44',
  CONFIRMED: '#1971c2',
  OVERDUE: '#e03131',
}

// O Intl do Bun devolve "R$\u00a0120,50" (NBSP); espaço comum é determinístico
// para quem compara o HTML — testes inclusive.
const money = (cents: number): string =>
  (cents / 100)
    .toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    .replace(/\u00a0/g, ' ')

const date = (iso: string | null): string => {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

export function invoicePage(ctx: AppContext) {
  return new Elysia({ name: 'invoice-page' }).get('/i/:id', async ({ params, set }) => {
    const raw = String(params.id)
    const id = raw.startsWith('pay_') ? raw : `pay_${raw}`

    const [row] = await ctx.db.select().from(payments).where(eq(payments.id, id)).limit(1)

    set.headers['content-type'] = 'text/html; charset=utf-8'

    if (!row) {
      set.status = 404
      return `<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<title>Cobrança não encontrada</title>
<body style="font-family:sans-serif;padding:2rem">
<h1>Cobrança não encontrada</h1>
<p>Nenhuma cobrança com o id <code>${esc(raw)}</code> neste simulador.</p>
</body></html>`
    }

    const label = STATUS_LABEL[row.status] ?? row.status
    const color = STATUS_COLOR[row.status] ?? '#868e96'

    return `<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cobrança ${esc(row.id)}</title>
<body style="font-family:sans-serif;padding:2rem;max-width:32rem;margin:auto">
<p style="color:#868e96;font-size:.8rem;margin:0 0 .5rem">Asaas Mock Server — página de leitura</p>
<h1 style="margin:0 0 1rem">${money(row.valueCents)}
<span style="font-size:.8rem;color:${color};background:${color}1a;border-radius:1rem;padding:.2rem .6rem;vertical-align:middle">${esc(label)}</span></h1>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:.4rem 0;color:#495057">Vencimento</td><td style="padding:.4rem 0;text-align:right"><strong>${date(row.dueDate)}</strong></td></tr>
<tr><td style="padding:.4rem 0;color:#495057">Forma</td><td style="padding:.4rem 0;text-align:right"><strong>${esc(row.billingType)}</strong></td></tr>
${row.description ? `<tr><td style="padding:.4rem 0;color:#495057">Descrição</td><td style="padding:.4rem 0;text-align:right"><strong>${esc(row.description)}</strong></td></tr>` : ''}
<tr><td style="padding:.4rem 0;color:#495057">Id</td><td style="padding:.4rem 0;text-align:right"><code>${esc(row.id)}</code></td></tr>
</table>
<p style="margin-top:1.5rem;font-size:.85rem;color:#495057">
Simulador: o pagamento é simulado no painel ou via
<code>POST /v3/payments/${esc(row.id)}/receiveInCash</code>.
<a href="/#payments">Abrir no painel →</a>
</p>
</body></html>`
  })
}
