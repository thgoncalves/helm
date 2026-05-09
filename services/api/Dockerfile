# Multi-stage Lambda container image for the Helm API.
#
# Base image: AWS-provided Python 3.12 Lambda runtime.
# Build: install uv, sync dependencies, copy app code.
# CMD:  Mangum handler at app.main.handler.

FROM public.ecr.aws/lambda/python:3.12

# Install uv for fast, reproducible dependency installation.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency manifests first so Docker layer caching applies.
COPY pyproject.toml uv.lock ${LAMBDA_TASK_ROOT}/

# Install runtime dependencies into the system Python used by the Lambda
# runtime. --frozen ensures the exact versions in uv.lock are used.
# --no-dev excludes test dependencies from the production image.
RUN uv sync --frozen --no-dev --no-install-project \
    --python /var/lang/bin/python3.12 \
    --system

# Copy application source code.
COPY app/ ${LAMBDA_TASK_ROOT}/app/

# Lambda invokes the handler via the CMD string.
CMD [ "app.main.handler" ]
