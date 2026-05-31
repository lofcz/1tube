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

    "require-access-policy": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Require every serve() call to declare an access policy via the `require` option",
        },
        messages: {
          missingRequire:
            'serve() must declare an access policy. Add { require: "public" }, { require: ["authenticated"] }, or { require: ["isAdminOrHigher"] } etc.',
        },
        schema: [],
      },
      create(context) {
        function hasRequireProperty(node) {
          return node.properties.some(
            (p) =>
              p.type === "Property" &&
              p.key.type === "Identifier" &&
              p.key.name === "require",
          );
        }

        return {
          CallExpression(node) {
            if (
              node.callee.type !== "Identifier" ||
              node.callee.name !== "serve"
            ) {
              return;
            }

            if (
              node.arguments[0] &&
              node.arguments[0].type === "ObjectExpression"
            ) {
              if (!hasRequireProperty(node.arguments[0])) {
                context.report({ node, messageId: "missingRequire" });
              }
              return;
            }

            const opts = node.arguments[1];

            if (!opts || opts.type !== "ObjectExpression") {
              context.report({ node, messageId: "missingRequire" });
              return;
            }

            if (!hasRequireProperty(opts)) {
              context.report({ node, messageId: "missingRequire" });
            }
          },
        };
      },
    },

    "no-ad-hoc-edge-json-response": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow constructing JSON responses directly in route-first edge functions",
        },
        messages: {
          useSharedResponse:
            "Route-first edge functions must use shared response helpers from _shared/handler.ts instead of constructing JSON responses directly.",
        },
        schema: [],
      },
      create(context) {
        const serveBindings = new Set();
        const handlerNamespaceBindings = new Set();
        const routeFirstServeCalls = new WeakSet();
        let hasRouteFirstServeCall = false;

        function isHandlerImportSource(value) {
          return typeof value === "string" &&
            /(?:^|\/)_shared\/handler(?:\.[cm]?[jt]s)?$/.test(value);
        }

        function propertyName(prop) {
          if (prop.type === "Identifier") return prop.name;
          if (prop.type === "Literal") return String(prop.value);
          return null;
        }

        function hasObjectProperty(node, name) {
          return node.properties.some((p) =>
            p.type === "Property" && propertyName(p.key) === name
          );
        }

        function isKnownServeCallee(node) {
          if (node.type === "Identifier") return serveBindings.has(node.name);
          return node.type === "MemberExpression" &&
            node.object.type === "Identifier" &&
            handlerNamespaceBindings.has(node.object.name) &&
            propertyName(node.property) === "serve";
        }

        function isServeConfig(node) {
          return node.type === "CallExpression" &&
            isKnownServeCallee(node.callee) &&
            node.arguments[0] &&
            node.arguments[0].type === "ObjectExpression" &&
            hasObjectProperty(node.arguments[0], "routes");
        }

        function isJsonStringifyCall(node) {
          return node &&
            node.type === "CallExpression" &&
            node.callee.type === "MemberExpression" &&
            node.callee.object.type === "Identifier" &&
            node.callee.object.name === "JSON" &&
            node.callee.property.type === "Identifier" &&
            node.callee.property.name === "stringify";
        }

        function isNewJsonResponse(node) {
          return node.type === "NewExpression" &&
            node.callee.type === "Identifier" &&
            node.callee.name === "Response" &&
            node.arguments &&
            node.arguments[0] &&
            isJsonStringifyCall(node.arguments[0]);
        }

        function isResponseJsonCall(node) {
          return node.type === "CallExpression" &&
            node.callee.type === "MemberExpression" &&
            node.callee.object.type === "Identifier" &&
            node.callee.object.name === "Response" &&
            node.callee.property.type === "Identifier" &&
            node.callee.property.name === "json";
        }

        function isInsideRouteFirstServeCall(node) {
          let current = node.parent;
          while (current) {
            if (routeFirstServeCalls.has(current)) return true;
            current = current.parent;
          }
          return false;
        }

        function shouldReport(node) {
          return hasRouteFirstServeCall || isInsideRouteFirstServeCall(node);
        }

        return {
          ImportDeclaration(node) {
            if (!isHandlerImportSource(node.source.value)) return;
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportSpecifier" &&
                propertyName(specifier.imported) === "serve"
              ) {
                serveBindings.add(specifier.local.name);
              }
              if (specifier.type === "ImportNamespaceSpecifier") {
                handlerNamespaceBindings.add(specifier.local.name);
              }
            }
          },
          CallExpression(node) {
            if (isServeConfig(node)) {
              routeFirstServeCalls.add(node);
              hasRouteFirstServeCall = true;
              return;
            }
            if (shouldReport(node) && isResponseJsonCall(node)) {
              context.report({ node, messageId: "useSharedResponse" });
            }
          },
          NewExpression(node) {
            if (shouldReport(node) && isNewJsonResponse(node)) {
              context.report({ node, messageId: "useSharedResponse" });
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
