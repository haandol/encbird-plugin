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
        python3 \
        sudo \
        unzip \
    && git lfs install --system \
    && mkdir -p /workspaces/encbird-plugin/node_modules /workspaces/encbird-plugin/.test-tmp \
    && chown -R node:node /workspaces/encbird-plugin

COPY prepare-volumes.sh /usr/local/bin/encbird-prepare-volumes
RUN chmod 0755 /usr/local/bin/encbird-prepare-volumes \
    && mkdir -p /usr/local/share/encbird-plugin \
    && printf '%s\n' encbird-plugin-devcontainer-v1 > /usr/local/share/encbird-plugin/container \
    && chmod 0444 /usr/local/share/encbird-plugin/container \
    && printf '%s\n' 'node ALL=(root) NOPASSWD: /usr/local/bin/encbird-prepare-volumes' > /etc/sudoers.d/encbird-plugin \
    && chmod 0440 /etc/sudoers.d/encbird-plugin

ENV SHELL=/bin/bash
USER node
WORKDIR /workspaces/encbird-plugin
