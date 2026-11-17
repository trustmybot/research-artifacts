ARG BASE_IMAGE
FROM --platform=linux/amd64 ${BASE_IMAGE}

RUN curl -fsSL -o /tmp/claude.tgz https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.311.tgz \
    && echo "4353c611f9a33063c5525348a15f1212bdc0085e4a7a81b8370b790003df1b56  /tmp/claude.tgz" | sha256sum -c - \
    && tar -xzf /tmp/claude.tgz -C /usr/local/bin --strip-components=1 package/claude \
    && rm /tmp/claude.tgz

WORKDIR /testbed
