# ==============================================================================
# Dockerfile Multi-Stage para Hotel Messenger (Microserviço de Email)
# Tecnologias: Node.js 22 LTS, TypeScript, RabbitMQ Worker, Handlebars
# ==============================================================================

# ------------------------------------------------------------------------------
# 1. Estágio Base: Imagem oficial do Node.js com versão fixada
# ------------------------------------------------------------------------------
FROM node:22-alpine3.21 AS base

# Define o diretório de trabalho padrão da aplicação
WORKDIR /app

# ------------------------------------------------------------------------------
# 2. Estágio de Dependências: Cache otimizado dos módulos npm
# ------------------------------------------------------------------------------
FROM base AS dependencies

# Copia os manifestos de dependência primeiro para aproveitar o cache de camadas
COPY package.json package-lock.json ./

# Instala todas as dependências (incluindo devDependencies necessárias para compilação)
# npm ci garante instalação determinística a partir do package-lock.json
RUN npm ci

# ------------------------------------------------------------------------------
# 3. Estágio de Desenvolvimento (Opcional - para uso local com tsx/hot-reload)
# Target: development
# ------------------------------------------------------------------------------
FROM base AS development

ENV NODE_ENV=development

# Copia as dependências completas
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Permissão para o usuário não-root nativo do Node.js
USER node

# Executa em modo desenvolvimento usando tsx
CMD ["npm", "run", "dev"]

# ------------------------------------------------------------------------------
# 4. Estágio de Build: Compilação TypeScript e poda de devDependencies
# ------------------------------------------------------------------------------
FROM dependencies AS builder

# Copia configurações do TypeScript e código fonte para compilação
COPY tsconfig.json ./
COPY src ./src

# Transpila o TypeScript para JavaScript ES2022 (gera diretório ./dist)
RUN npm run build

# Remove as devDependencies mantendo apenas os pacotes estritamente necessários para produção
RUN npm prune --omit=dev

# ------------------------------------------------------------------------------
# 5. Estágio Final de Produção: Imagem mínima e segura
# Target: production
# ------------------------------------------------------------------------------
FROM node:22-alpine3.21 AS production

WORKDIR /app

# Define ambiente produtivo otimizando bibliotecas Node.js
ENV NODE_ENV=production

# Copia apenas os artefatos compilados e manifestos necessários
COPY --chown=node:node --from=builder /app/package.json ./package.json
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist

# IMPORTANTE: O serviço localiza templates Handlebars em runtime dentro de "src/templates/"
# Copiamos a pasta de templates para que o templateService.ts carregue os arquivos .hbs
COPY --chown=node:node src/templates ./src/templates

# Executa o contêiner como usuário sem privilégios (non-root) para maior segurança
USER node

# Healthcheck do worker: Como não há porta HTTP aberta, valida se o processo principal está ativo
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD kill -0 1 || exit 1

# Inicializa o worker em produção
CMD ["node", "dist/index.js"]
