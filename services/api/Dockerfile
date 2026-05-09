# Lambda container image for the Helm API.
#
# Base image: AWS-provided Python 3.12 Lambda runtime.
# Build: export locked deps to requirements.txt, install into the Lambda
# task root, then copy app code.
# CMD: Mangum handler at app.main.handler.

FROM public.ecr.aws/lambda/python:3.12

# Install uv for fast, reproducible dependency resolution.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency manifests first so Docker layer caching applies.
COPY pyproject.toml uv.lock ${LAMBDA_TASK_ROOT}/

# Lambda containers need packages at LAMBDA_TASK_ROOT (not in a .venv).
# uv sync targets a venv, so we use uv export → uv pip install --target.
# --no-emit-project skips emitting the helm-api project itself; we copy
# app/ explicitly below.
RUN cd ${LAMBDA_TASK_ROOT} && \
    uv export --frozen --no-dev --no-emit-project -o requirements.txt && \
    uv pip install --no-cache --target ${LAMBDA_TASK_ROOT} -r requirements.txt && \
    rm requirements.txt pyproject.toml uv.lock

# Copy application source code.
COPY app/ ${LAMBDA_TASK_ROOT}/app/

# Lambda invokes the handler via the CMD string.
CMD [ "app.main.handler" ]
