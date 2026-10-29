# Plataforma de Verificação de Identidade

API para empresas parceiras iniciarem verificações de identidade (selfie com prova de vida + documento), análise automatizada com score de 0 a 100 e fila de revisão manual.

Proposta técnica completa: arquitetura, fornecedores, custos e roadmap estão no documento da proposta.

## O que já funciona

- **API para empresas** (`/v1/verifications`): criar, consultar, cancelar e abrir nova sessão; chave de API por empresa; `Idempotency-Key`.
- **Endpoints do SDK** (`/v1/sdk`): sessão, início da prova de vida, upload de capturas com checagem de qualidade e pedido de nova tentativa, envio para análise.
- **Análise** em segundo plano: prova de vida, tipo de documento, extração de dados, consistência (dígitos do CPF, validade, datas), face match, validação de CPF, adulteração e reuso de captura.
- **Motor de decisão**: falhas técnicas viram `technical_error` (nunca reprovação); falha crítica nunca é compensada pelo score; aprovação automática só com score ≥ limite da empresa (padrão 80) e todas as verificações obrigatórias aprovadas.
- **Revisão manual** (`/v1/review`): fila (suspeitos primeiro), evidências, imagens e decisão com justificativa obrigatória (aprovar, reprovar ou pedir novas capturas).
- **Webhooks** assinados com HMAC a cada mudança de status, com retentativas.
- **Multi-tenant** com Row-Level Security no PostgreSQL: o isolamento entre empresas é imposto pelo banco.
- **Auditoria**: toda decisão registra motivo e origem (automática ou humana); visualização de evidências fica logada.

## Fornecedores

Ainda não há fornecedor contratado. Cada verificação depende de um contrato em `src/providers/providers.ts` (`LivenessProvider`, `DocumentProvider`, `FaceMatchProvider`, `CpfProvider`), hoje atendido por adaptadores simulados em `src/providers/mock`. Para integrar um fornecedor real, crie o adaptador e registre-o em `src/app.module.ts`.

No ambiente sandbox, envie `metadata.mock_scenario` ao criar a verificação para simular um resultado: `approve`, `liveness_spoof`, `face_mismatch`, `face_borderline`, `cpf_irregular`, `unreadable_cpf`, `tampered_document`, `expired_document`, `provider_down`.

## Rodando localmente

Precisa apenas de Docker.

```bash
export HOST_UID=$(id -u) HOST_GID=$(id -g)
docker compose up -d db
docker compose run --rm api npm install
docker compose run --rm api npm run migrate
docker compose run --rm api npm run seed     # imprime a chave de API e o token de analista
docker compose up api                        # http://localhost:3000/health
```

Testes:

```bash
docker compose run --rm api npm test          # unitários
docker compose run --rm api npm run test:e2e  # fluxo completo contra o Postgres
```

## Fluxo da API

```bash
# 1. Backend da empresa cria a verificação
curl -X POST localhost:3000/v1/verifications \
  -H "Authorization: Bearer $API_KEY" -H 'content-type: application/json' \
  -d '{"external_user_id":"cliente-123","journey":"signup"}'
# -> { id, status, session_token, session_expires_at }

# 2. SDK (com o session_token)
curl -X POST localhost:3000/v1/sdk/liveness -H "X-Session-Token: $SESSION"
curl -X POST localhost:3000/v1/sdk/captures -H "X-Session-Token: $SESSION" \
  -F kind=selfie -F liveness_session_id=$LIVENESS_ID -F file=@selfie.jpg
curl -X POST localhost:3000/v1/sdk/captures -H "X-Session-Token: $SESSION" \
  -F kind=document_front -F file=@frente.jpg
curl -X POST localhost:3000/v1/sdk/submit -H "X-Session-Token: $SESSION"

# 3. Empresa consulta o resultado (ou recebe o webhook)
curl localhost:3000/v1/verifications/$ID -H "Authorization: Bearer $API_KEY"
```

Status possíveis: `created`, `capturing`, `analyzing`, `in_review`, `approved`, `rejected`, `resubmission_requested`, `technical_error`, `expired`, `cancelled`.

## Próximos passos

- [ ] SDK web de captura (`apps/sdk-web`)
- [ ] Painel do analista (`apps/dashboard`)
- [ ] Adaptadores reais: AWS Rekognition (liveness e face match) e bureau de CPF
- [ ] POC de OCR/documentoscopia (CAF, Regula) e adaptador do vencedor
- [ ] Serviço de análise de imagem em Python (nitidez, reflexo, enquadramento, hash perceptual)
- [ ] Armazenamento em S3 com KMS e exclusão por prazo de retenção
- [ ] OIDC + MFA para analistas e restrição de analistas por empresa
- [ ] Criptografia de CPF e dados extraídos em nível de coluna
