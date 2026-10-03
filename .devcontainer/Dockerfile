FROM node:24-alpine3.22

RUN apk add --no-cache \
        bash \
        ca-certificates \
        curl \
        git \
        git-lfs \
        github-cli \
        jq \
        lazygit \
        less \
        libstdc++ \
        openssh-client \
        ripgrep \
    && git lfs install --system \
    && mkdir -p /workspaces/encbird-plugin/node_modules /workspaces/encbird-plugin/.test-tmp \
    && chown -R node:node /workspaces/encbird-plugin

ENV SHELL=/bin/bash
USER node
WORKDIR /workspaces/encbird-plugin
