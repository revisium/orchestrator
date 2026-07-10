import { resolve } from 'node:path';

const SUITE_ROOTS = ['pipeline', 'integration', 'surfaces', 'runtime'];
const RAW_IMPORTS = [
  '/src/task-control-plane/',
  '/src/engine/dbos',
  '/src/revisium/',
  '/src/storage/',
  '/src/mcp/',
  '/src/api/graphql-api/',
  '/src/cli/commands/',
  '/src/host/',
  '/src/runners/',
  '/src/poller/',
  '/src/worker/',
  '/src/provider/',
  '/src/providers/',
];
const RAW_PROPERTIES = new Set([
  'api',
  'context',
  'dbos',
  'lifecycle',
  'developerWrites',
  'agentCalls',
  'ghCalls',
  'getRunEvents',
  'appendEvent',
]);
const PRIVILEGED_SUPPORT_IMPORTS = [
  '/src/e2e/support/agents',
  '/src/e2e/support/case-plan',
  '/src/e2e/support/crash',
  '/src/e2e/support/drive',
  '/src/e2e/support/fake-integrator',
  '/src/e2e/support/gh-emulator',
  '/src/e2e/support/git-target-repo',
  '/src/e2e/support/harness',
  '/src/e2e/support/isolated-profile',
  '/src/e2e/support/persisted-facts',
  '/src/e2e/support/run-profiles',
  '/src/e2e/support/scenarios',
];

function normalizedFilename(context) {
  return context.filename.replaceAll('\\', '/');
}

function suiteRoot(filename) {
  const match = /(?:^|\/)src\/e2e\/(pipeline|integration|surfaces|runtime)\//.exec(filename);
  return match?.[1];
}

function isFocusedTest(filename) {
  const sourceFile = filename.includes('/src/') || filename.startsWith('src/');
  const e2eFile = filename.includes('/src/e2e/') || filename.startsWith('src/e2e/');
  return sourceFile && filename.endsWith('.test.ts') && !e2eFile;
}

function resolvedImport(filename, source) {
  if (!source.startsWith('.')) return source.replaceAll('\\', '/');
  return resolve(filename, '..', source).replaceAll('\\', '/');
}

function importedSuiteRoot(filename, source) {
  const target = resolvedImport(filename, source);
  return SUITE_ROOTS.find((root) => target.includes(`/src/e2e/${root}/`));
}

function isBroadBarrel(filename, source) {
  return /\/src\/e2e\/(?:kit|support)\/index(?:\.js)?$/.test(resolvedImport(filename, source));
}

function isRawImport(source, layer) {
  if (RAW_IMPORTS.some((part) => source.includes(part))) return true;
  if (PRIVILEGED_SUPPORT_IMPORTS.some((part) => source.includes(part))) return true;
  return (layer === 'pipeline' || layer === 'surfaces') &&
    (source === 'node:child_process' || source.startsWith('node:child_process/'));
}

function staticPropertyName(node) {
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
  const property = node.property ?? node.key;
  if (!node.computed && property?.type === 'Identifier') return property.name;
  if (property?.type === 'Literal' && typeof property.value === 'string') return property.value;
  if (property?.type === 'TemplateLiteral' && property.expressions.length === 0) {
    return property.quasis[0]?.value.cooked;
  }
  return undefined;
}

function looksLikeRunRoutingMap(name) {
  const tokens = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
  const runIndex = tokens.findIndex((token) => token === 'run' || token === 'runs');
  if (runIndex < 0) return false;
  const routingTokens = new Set([
    'case', 'cases', 'plan', 'plans', 'spec', 'specs', 'route', 'routes', 'routing',
    'behavior', 'behaviors', 'response', 'responses', 'scenario', 'scenarios', 'state', 'states',
  ]);
  return tokens.some((token) => routingTokens.has(token));
}

function isMapConstructor(node) {
  if (node.type === 'Identifier') return node.name === 'Map';
  if (node.type !== 'MemberExpression' || node.object.type !== 'Identifier' || node.object.name !== 'globalThis') {
    return false;
  }
  return staticPropertyName(node) === 'Map';
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      direction: 'test dependency direction violation: {{detail}}',
      lateral: 'suite-to-suite imports are forbidden: {{source}}',
      barrel: 'the broad E2E barrel is forbidden; import one explicit context or support module',
      rawAccess: '{{layer}} suites must use their typed context instead of raw access "{{name}}"',
      runRoutingMap: 'controlled behavior must be declared in an immutable pre-start case plan, not a mutable run-routing map',
    },
  },
  create(context) {
    const filename = normalizedFilename(context);
    const layer = suiteRoot(filename);
    const supportModule = filename.includes('/src/e2e/support/') || filename.startsWith('src/e2e/support/');

    function checkImport(node, source) {
      if (isBroadBarrel(filename, source)) {
        context.report({ node, messageId: 'barrel' });
        return;
      }

      const targetSuite = importedSuiteRoot(filename, source);
      if (layer && targetSuite) {
        context.report({ node, messageId: 'lateral', data: { source } });
        return;
      }
      if (supportModule && targetSuite) {
        context.report({
          node,
          messageId: 'direction',
          data: { detail: `support cannot import ${targetSuite} suites` },
        });
        return;
      }
      if (isFocusedTest(filename) && resolvedImport(filename, source).includes('/src/e2e/support/')) {
        context.report({
          node,
          messageId: 'direction',
          data: { detail: 'focused and static-policy tests cannot import E2E support' },
        });
        return;
      }
      if (layer && isRawImport(resolvedImport(filename, source), layer)) {
        context.report({
          node,
          messageId: 'rawAccess',
          data: { layer, name: source },
        });
      }
    }

    return {
      ImportDeclaration(node) {
        checkImport(node, String(node.source.value));
      },
      ImportExpression(node) {
        if (node.source.type !== 'Literal' || typeof node.source.value !== 'string') return;
        checkImport(node, node.source.value);
      },
      MemberExpression(node) {
        if (layer !== 'pipeline' && layer !== 'surfaces') return;
        const name = staticPropertyName(node);
        if (!name || !RAW_PROPERTIES.has(name)) return;
        context.report({
          node,
          messageId: 'rawAccess',
          data: { layer, name },
        });
      },
      Property(node) {
        if (layer !== 'pipeline' && layer !== 'surfaces') return;
        if (node.parent.type !== 'ObjectPattern') return;
        const name = staticPropertyName(node);
        if (!name || !RAW_PROPERTIES.has(name)) return;
        context.report({
          node,
          messageId: 'rawAccess',
          data: { layer, name },
        });
      },
      VariableDeclarator(node) {
        if (!layer) return;
        if (node.id.type !== 'Identifier' || !looksLikeRunRoutingMap(node.id.name)) return;
        if (node.init?.type !== 'NewExpression' || !isMapConstructor(node.init.callee)) return;
        context.report({ node, messageId: 'runRoutingMap' });
      },
    };
  },
};
