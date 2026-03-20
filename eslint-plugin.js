/**
 * ESLint plugin for projects consuming 1tube.
 *
 * Prevents accidentally building edge-function URLs from SUPABASE_URL
 * (which bypasses the 1tube gateway) and from using EDGE_URL directly
 * (which skips the named constant pattern in api.ts).
 *
 * Usage in eslint.config.js (flat config):
 *
 *   import oneTube from "1tube/eslint-plugin";
 *
 *   export default defineConfig({
 *     plugins: { "1tube": oneTube },
 *     rules: {
 *       "1tube/no-supabase-function-urls": "error",
 *       "1tube/no-direct-edge-url": "error",
 *     },
 *   });
 */

const plugin = {
  rules: {
    "no-supabase-function-urls": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow building edge-function URLs from API_CONFIG.SUPABASE_URL",
        },
        messages: {
          useFnConstant:
            "Don't build function URLs from API_CONFIG.SUPABASE_URL — use the named API_CONFIG.*_URL constants (routed via EDGE_URL / 1tube). Add a new constant in api.ts if one is missing.",
        },
        schema: [],
      },
      create(context) {
        return {
          TemplateLiteral(node) {
            const exprs = node.expressions;
            const quasis = node.quasis;
            for (let i = 0; i < exprs.length; i++) {
              const expr = exprs[i];
              if (
                expr.type === "MemberExpression" &&
                expr.object.type === "Identifier" &&
                expr.object.name === "API_CONFIG" &&
                expr.property.type === "Identifier" &&
                expr.property.name === "SUPABASE_URL" &&
                quasis[i + 1] &&
                /^\/functions\b/.test(quasis[i + 1].value.raw)
              ) {
                context.report({ node: expr, messageId: "useFnConstant" });
              }
            }
          },
        };
      },
    },

    "no-direct-edge-url": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow using API_CONFIG.EDGE_URL directly to construct URLs",
        },
        messages: {
          useNamedConstant:
            "Don't use API_CONFIG.EDGE_URL directly — use the named API_CONFIG.*_URL constants instead (e.g. API_CONFIG.AUTH_ME_URL). Add a new constant in api.ts if one is missing.",
        },
        schema: [],
      },
      create(context) {
        return {
          MemberExpression(node) {
            if (
              node.object.type === "Identifier" &&
              node.object.name === "API_CONFIG" &&
              node.property.type === "Identifier" &&
              node.property.name === "EDGE_URL"
            ) {
              context.report({ node, messageId: "useNamedConstant" });
            }
          },
        };
      },
    },
  },
};

export default plugin;
