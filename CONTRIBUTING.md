# Contributing to Node Webhook Engine

Thank you for your interest in contributing to **Node Webhook Engine**!

## Development Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-org/node-webhook-engine.git
   cd node-webhook-engine
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run TypeScript typecheck**:
   ```bash
   npm run typecheck
   ```

4. **Run unit & integration tests**:
   ```bash
   npm test
   ```

5. **Run benchmarks**:
   ```bash
   npm run bench
   ```

6. **Build distribution**:
   ```bash
   npm run build
   ```

## Pull Request Guidelines

- Ensure all new features or bug fixes include corresponding unit or integration tests in `tests/`.
- Ensure `npm run typecheck`, `npm test`, and `npm run build` pass with zero errors.
- Follow existing code conventions and formatting.
- Open an issue before submitting large architectural changes.

