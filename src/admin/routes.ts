/**
 * Endpoints administrativos. NÃO existem na API do Asaas.
 *
 * São a razão de este simulador ser mais útil que o sandbox real: viagem no
 * tempo, reset determinístico, log de entregas de webhook. Ficam fora de /v3 e
 * não pedem `access_token`, para que nenhuma app cliente os alcance por engano.
 *
 * Desligue com ADMIN_ENABLED=false em qualquer ambiente compartilhado.
 */
import { desc, eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { driftDays, realNowMs, VirtualClock } from '../core/clock.ts'
import type { AppContext } from '../core/context.ts'
import { badRequest } from '../core/errors.ts'
import { accounts, apiKeys, webhookDeliveries, webhookEvents } from '../db/schema/index.ts'
import { CARD_ERRORS, detectBrand, TEST_CARDS, TRIGGERS } from '../domain/credit-card.ts'
import { personTypeOf } from '../domain/cpf-cnpj.ts'
import * as ids from '../domain/ids.ts'
import type { DB } from '../db/client.ts'
import { OPERATION_COUNT, OPERATION_IDS } from '../generated/operations.ts'
import { createAccountDocuments } from '../modules/account-documents/service.ts'
import type { Scheduler } from '../scheduler/scheduler.ts'

export function adminRoutes(ctx: AppContext, scheduler: Scheduler) {
  const virtual = (): VirtualClock => {
    if (!(ctx.clock instanceof VirtualClock)) {
      throw badRequest(
        'clock_not_virtual',
        'O relógio está em modo REAL. Suba com CLOCK_MODE=VIRTUAL_FROZEN ou ' +
          'VIRTUAL_FLOWING para poder viajar no tempo.',
      )
    }
    return ctx.clock
  }

  const app = new Elysia({ name: 'admin', prefix: '/_admin' })

  if (!ctx.config.adminEnabled) {
    return app.all('/*', () => {
      throw badRequest('admin_disabled', 'Os endpoints administrativos estão desabilitados.')
    })
  }

  return (
    app
      /**
       * `driftDays` é o campo que faltava — e a falta dele custou caro.
       *
       * O relógio é GLOBAL ao container: um clique em `+32` no painel move o tempo
       * para TODO MUNDO, inclusive para a aplicação que está integrando do outro
       * lado. O sintoma não parece um relógio: parece que "o Pix nasce OVERDUE",
       * porque a cobrança criada com vencimento hoje já venceu faz um mês do ponto
       * de vista do simulador.
       *
       * Sem um número aqui, nem o painel nem ninguém tem como avisar.
       */
      .get('/clock', () => ({
        mode: ctx.clock.mode,
        now: ctx.clock.timestamp(),
        today: ctx.clock.today(),
        epochMs: ctx.clock.nowMs(),
        /** Dias à frente do tempo REAL. 0 = o simulador está no presente. */
        driftDays: driftDays(ctx.clock),
      }))

      /**
       * Troca o `publicBaseUrl` em TEMPO DE EXECUÇÃO — o que o `PUBLIC_BASE_URL`
       * do env não consegue fazer sem recriar o container.
       *
       * O caso de uso é o túnel: quando o dev expõe este simulador num
       * `*.trycloudflare.com` (script de share do central-do-associado), as URLs
       * que a API DEVOLVE (`invoiceUrl`, `bankSlipUrl`…) continuariam apontando
       * para `central-do-associado.ddev.site:45445` — inalcançável de fora da
       * máquina. O túnel chama este endpoint com a URL pública dele, e as
       * cobranças criadas a partir daí carregam links clicáveis. Ao encerrar, o
       * próprio script devolve o valor local.
       *
       * Volta ao valor do env no próximo restart do container, de propósito:
       * túnel é estado de sessão, não configuração persistida.
       */
      .get('/config/public-base-url', () => ({ publicBaseUrl: ctx.config.publicBaseUrl }))
      .post(
        '/config/public-base-url',
        ({ body }) => {
          let parsed: URL
          try {
            parsed = new URL(body.url)
          } catch {
            throw badRequest('invalid_url', `"${body.url}" não é uma URL absoluta.`)
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw badRequest('invalid_url', 'publicBaseUrl precisa começar com http:// ou https://')
          }
          parsed.search = ''
          parsed.hash = ''
          // Sem barra final: `${base}/i/${id}` montaria `...//i/`.
          ctx.config.publicBaseUrl = parsed.toString().replace(/\/+$/, '')
          return { publicBaseUrl: ctx.config.publicBaseUrl }
        },
        { body: t.Object({ url: t.String({ minLength: 1 }) }) },
      )

      /**
       * Volta o relógio para o tempo real. A saída da viagem no tempo.
       *
       * Existe porque `advance` só anda para a frente, e quem avançou 32 dias para
       * ver um cartão creditar ficava preso lá — com toda cobrança nova nascendo
       * vencida, sem nada na tela dizendo por quê.
       *
       * Voltar o relógio NÃO basta: as entregas de webhook que o backoff reagendou
       * enquanto estávamos no futuro continuam agendadas lá, inalcançáveis — e em
       * SEQUENTIALLY (o padrão do Asaas) a primeira delas trava a fila inteira por
       * trás. Por isso o reset também as puxa de volta. Sem isso, o relógio volta ao
       * presente e nenhum webhook chega mais, para sempre.
       */
      .post('/clock/reset', async () => {
        virtual()
        const clock = ctx.clock as unknown as { setTo(epochMs: number): void }
        clock.setTo(realNowMs())

        const { pullBackFutureDeliveries } = await import('../webhooks/dispatcher.ts')
        const rescheduled = await pullBackFutureDeliveries(ctx, ctx.clock.nowMs())

        return {
          now: ctx.clock.timestamp(),
          today: ctx.clock.today(),
          driftDays: 0,
          /** Entregas que estavam presas no futuro e voltaram para a fila. */
          rescheduledDeliveries: rescheduled,
        }
      })

      /**
       * Avança o relógio. UM TICK COMPLETO POR DIA SIMULADO — é o que faz uma
       * assinatura gerar várias cobranças em vez de uma, e o OVERDUE cair na
       * data certa.
       *
       * Devolve um TickReport por dia, com as transições que aconteceram. É isso
       * que faz um teste ler como especificação:
       *
       *   const [r] = await advance({ days: 32 })
       *   expect(r.transitions).toContainEqual({ from: 'CONFIRMED', to: 'RECEIVED', … })
       */
      .post(
        '/clock/advance',
        async ({ body }) => {
          virtual()
          const reports = []
          if (body.days) reports.push(...(await scheduler.advanceDays(body.days)))

          const subDayMs =
            (body.hours ?? 0) * 3_600_000 +
            (body.minutes ?? 0) * 60_000 +
            (body.seconds ?? 0) * 1000
          if (subDayMs > 0) reports.push(await scheduler.advanceMs(subDayMs))

          return { now: ctx.clock.timestamp(), reports }
        },
        {
          body: t.Object({
            days: t.Optional(t.Integer({ minimum: 0, maximum: 3650 })),
            hours: t.Optional(t.Integer({ minimum: 0 })),
            minutes: t.Optional(t.Integer({ minimum: 0 })),
            seconds: t.Optional(t.Integer({ minimum: 0 })),
          }),
        },
      )

      .post(
        '/clock/set',
        async ({ body }) => {
          const clock = virtual()
          const target = new Date(body.date)
          if (Number.isNaN(target.getTime())) {
            throw badRequest('invalid_date', `Data inválida: "${body.date}".`)
          }
          clock.setTo(target.getTime())

          // `set` também anda PARA TRÁS, e aí cai na mesma armadilha do reset: as
          // entregas reagendadas no futuro ficam inalcançáveis e travam a fila.
          const { pullBackFutureDeliveries } = await import('../webhooks/dispatcher.ts')
          const rescheduled = await pullBackFutureDeliveries(ctx, ctx.clock.nowMs())

          const report = await scheduler.tick()
          return { now: ctx.clock.timestamp(), report, rescheduledDeliveries: rescheduled }
        },
        { body: t.Object({ date: t.String() }) },
      )

      /** Um tick sem mexer no relógio. Útil para drenar a fila de webhooks. */
      .post('/tick', async () => scheduler.tick())

      /**
       * Provoca um chargeback numa cobrança paga. (Track H)
       *
       * Fica AQUI, e não em /v3, porque a API do Asaas não tem operação de criar
       * chargeback — quem abre é a bandeira, não o lojista. Sem esta porta, o
       * gatilho CHARGEBACK da máquina e as 3 operações da tag "Chargeback"
       * seriam inalcançáveis, e o dev não teria como testar o fluxo. É controle
       * do simulador, igual à viagem no tempo.
       */
      .post(
        '/payments/:id/chargeback',
        async ({ params, body }) => {
          const { openChargeback } = await import('../modules/chargebacks/service.ts')
          const b = (body ?? {}) as { reason?: string }
          const row = await openChargeback(ctx, params.id, b.reason ?? 'FRAUD')
          return { id: row.id, payment: row.paymentId, status: row.status, reason: row.reason }
        },
        { body: t.Optional(t.Object({ reason: t.Optional(t.String()) })) },
      )

      /**
       * "Situação das cobranças" — o agregado da home, por CONTA.
       *
       * Recebe o accountId em vez de deduzir da chave porque o painel troca de
       * conta sem trocar de sessão: é a única tela do mundo que enxerga o master e
       * as subcontas ao mesmo tempo, e é justamente assim que se vê o dinheiro de
       * um split andar de uma para a outra.
       */
      .get('/summary', async ({ query }) => {
        const { paymentsSummary } = await import('./summary.ts')
        const accountId = String(query.accountId ?? '')
        if (!accountId) throw badRequest('invalid_accountId', 'Informe accountId.')
        return { groups: await paymentsSummary(ctx, accountId) }
      })

      /**
       * Por que a fila de cada webhook não está andando.
       *
       * No Asaas você olha o painel e vê que travou. Aqui, até agora, você só
       * descobria lendo a API — e o sintoma na ponta ("o pagamento consta RECEIVED
       * mas meu pedido não atualizou") não aponta para webhook nenhum.
       */
      .get('/webhooks/queue', async () => {
        const { queueHealth } = await import('../webhooks/dispatcher.ts')
        return { webhooks: await queueHealth(ctx) }
      })

      .get('/webhooks/deliveries', async ({ query }) => {
        const rows = await ctx.db
          .select({
            id: webhookDeliveries.id,
            webhookId: webhookDeliveries.webhookId,
            status: webhookDeliveries.status,
            attempt: webhookDeliveries.attempt,
            nextAttemptAtMs: webhookDeliveries.nextAttemptAtMs,
            lastStatusCode: webhookDeliveries.lastStatusCode,
            lastError: webhookDeliveries.lastError,
            lastAttemptAt: webhookDeliveries.lastAttemptAt,
            event: webhookEvents.event,
            eventId: webhookEvents.id,
            payload: webhookEvents.payload,
          })
          .from(webhookDeliveries)
          .innerJoin(webhookEvents, eq(webhookDeliveries.eventId, webhookEvents.id))
          .orderBy(desc(webhookDeliveries.sequence))
          .limit(Number(query.limit ?? 50))

        return { data: rows }
      })

      /**
       * Congela o dispatcher. Necessário ao viajar no tempo por outro motivo:
       * um advance de 40 dias, sem isto, esgotaria as 15 tentativas de backoff de
       * qualquer entrega pendente e marcaria o webhook como `interrupted`.
       */
      .post('/webhooks/pause', () => {
        scheduler.paused = true
        return { paused: true }
      })
      .post('/webhooks/resume', () => {
        scheduler.paused = false
        return { paused: false }
      })

      /** Cobertura computada do manifesto — nunca mantida à mão. */
      .get('/coverage', () => {
        const implemented = ctx.coverage?.implemented ?? []
        const stubbed = ctx.coverage?.stubbed ?? []
        const variants = ctx.coverage?.variants ?? []

        // O denominador são as ROTAS: 5 operações da spec dividem rota com a
        // canônica (a variante "com cartão"), então não contam à parte.
        const routable = OPERATION_COUNT - variants.length

        return {
          specOperations: OPERATION_COUNT,
          routable,
          implemented: implemented.length,
          stubbed: stubbed.length,
          variants: variants.length,
          percent: Math.round((implemented.length / routable) * 100),
          registered: OPERATION_IDS.length,
          notImplemented: stubbed,
        }
      })

      .get('/fees', () => ctx.config.fees)

      .get('/jobs', () => ({ order: scheduler.jobNames, paused: scheduler.paused }))

      /**
       * Os cartões de teste e os erros que cada um força.
       *
       * A tabela vem do DOMÍNIO, não de uma cópia — é a MESMA constante que o
       * motor consulta para decidir o desfecho. Se a tela e o servidor pudessem
       * discordar, a tela mentiria com botão de copiar e tudo.
       *
       * `real: false` marca as extensões nossas: números que o Asaas de verdade
       * APROVARIA. Sem essa marca, alguém escreve um teste contra um comportamento
       * que só existe aqui e descobre em produção.
       */
      .get('/test-cards', () => ({
        cards: TEST_CARDS.map((c) => ({
          ...c,
          brand: detectBrand(c.number),
          error: c.outcome === 'APPROVE' ? null : CARD_ERRORS[c.outcome],
        })),
        // Três dos seis erros do Asaas não se disparam por número — são
        // propriedades de outros campos. Aqui vai como produzi-los.
        triggers: TRIGGERS.map((t) => ({ ...t, error: CARD_ERRORS[t.outcome] })),
      }))

      /**
       * Todas as contas do simulador, com SALDO e CHAVE DE API.
       *
       * Deliberadamente NÃO existe na API do Asaas, e não poderia existir: lá, uma
       * conta não enxerga a chave da outra, e a chave de uma subconta só aparece
       * uma vez, na criação. Aqui isso é justamente o ponto — é como o painel
       * mostra o dinheiro andando entre as contas num split, e como você entra
       * numa subconta sem ter guardado a chave dela.
       *
       * É introspecção de simulador. Vive atrás de `ADMIN_ENABLED`, fora de /v3, e
       * é a razão de esse flag existir.
       */
      .get('/accounts', async () => {
        const rows = await ctx.db
          .select()
          .from(accounts)
          .orderBy(accounts.parentAccountId, accounts.dateCreated)

        const keys = await ctx.db.select().from(apiKeys).where(eq(apiKeys.active, true))
        const keyOf = new Map(keys.map((k) => [k.accountId, k.key]))

        return {
          accounts: rows.map((a) => ({
            id: a.id,
            name: a.name,
            email: a.email,
            cpfCnpj: a.cpfCnpj,
            walletId: a.walletId,
            parentAccountId: a.parentAccountId,
            status: a.status,
            // Em reais, como toda fronteira de saída deste projeto.
            balance: a.balanceCents / 100,
            apiKey: keyOf.get(a.id) ?? null,
            dateCreated: a.dateCreated,
          })),
        }
      })

      /**
       * Cria uma conta RAIZ independente (parentAccountId = null) com chave
       * própria — o análogo local de "cada organização tem sua própria conta
       * Asaas", que é como o CDA opera: sem subcontas.
       *
       * A API real NÃO tem isso: contas raiz nascem do cadastro no site, e
       * `POST /v3/accounts` só cria subcontas. Por isso mora atrás do
       * `_admin`, como a viagem no tempo. Idempotente por `cpfCnpj`: chamar de
       * novo para o mesmo documento devolve a conta e a chave existentes, que é
       * o que permite re-seedar sem duplicar contas.
       */
      .post(
        '/accounts',
        async ({ body }) => {
          const b = body as { name: string; email?: string; cpfCnpj: string }
          const cpfCnpj = String(b.cpfCnpj).replace(/\D/g, '') || String(b.cpfCnpj)

          const [existing] = await ctx.db
            .select()
            .from(accounts)
            .where(eq(accounts.cpfCnpj, cpfCnpj))
            .limit(1)

          if (existing) {
            const [key] = await ctx.db
              .select()
              .from(apiKeys)
              .where(eq(apiKeys.accountId, existing.id))
              .limit(1)

            return {
              id: existing.id,
              walletId: existing.walletId,
              cpfCnpj: existing.cpfCnpj,
              name: existing.name,
              apiKey: key?.key ?? null,
              created: false,
            }
          }

          const now = ctx.clock.timestamp()
          const accountId = ids.accountId(ctx.rng)
          const walletId = ids.walletId(ctx.rng)
          const key = ids.apiKey(ctx.rng)
          const personType = personTypeOf(cpfCnpj)
          const name = String(b.name)

          await ctx.db.transaction(async (tx) => {
            await tx.insert(accounts).values({
              id: accountId,
              walletId,
              parentAccountId: null,
              name,
              companyName: null,
              tradingName: name,
              email: String(b.email ?? `${accountId}@mock.local`),
              loginEmail: null,
              cpfCnpj,
              personType,
              companyType: null,
              birthDate: null,
              mobilePhone: null,
              phone: null,
              site: null,
              address: null,
              addressNumber: null,
              complement: null,
              province: null,
              postalCode: null,
              city: null,
              state: null,
              country: 'Brasil',
              incomeCents: null,
              status: 'APPROVED',
              balanceCents: 0,
              accountNumber: `${ctx.rng.digits(6)}-${ctx.rng.digits(1)}`,
              dateCreated: now,
            })

            await tx.insert(apiKeys).values({
              id: ids.genericId(ctx.rng),
              accountId,
              key,
              name: 'Chave principal',
              active: true,
              dateCreated: now,
              expirationDate: null,
            })

            // Conta em uso no sandbox já vem com KYC aprovado; é o que a
            // mantém transacionando desde o primeiro request.
            await createAccountDocuments(
              tx as unknown as DB,
              { clock: ctx.clock, rng: ctx.rng, config: ctx.config },
              { accountId, name, personType, companyType: null, approved: true },
            )
          })

          return { id: accountId, walletId, cpfCnpj, name, apiKey: key, created: true }
        },
        {
          body: t.Object({
            name: t.String(),
            email: t.Optional(t.String()),
            cpfCnpj: t.String(),
          }),
        },
      )
  )
}
