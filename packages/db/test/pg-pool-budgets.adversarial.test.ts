import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const packagesRoot = join(import.meta.dir, "..", "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?tsx?$/.test(entry.name) ? [path] : [];
  });
}

function declarationsNamed(root: ts.Node, name: string, before: number): ts.VariableDeclaration[] {
  const matches: ts.VariableDeclaration[] = [];
  function visit(node: ts.Node): void {
    if (node.pos >= before) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.name.text === name && node.initializer) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return matches;
}

function expressionDeclaresMax(expression: ts.Expression, scope: ts.Node): boolean {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)) {
    return expressionDeclaresMax(expression.expression, scope);
  }
  if (ts.isConditionalExpression(expression)) {
    return expressionDeclaresMax(expression.whenTrue, scope)
      && expressionDeclaresMax(expression.whenFalse, scope);
  }
  if (ts.isIdentifier(expression)) {
    const declarations = declarationsNamed(scope, expression.text, expression.pos);
    return declarations.length === 1
      && expressionDeclaresMax(declarations[0]!.initializer!, scope);
  }
  if (!ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some((property) => {
    if (ts.isPropertyAssignment(property)) {
      return (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        && property.name.text === "max";
    }
    return ts.isSpreadAssignment(property) && expressionDeclaresMax(property.expression, scope);
  });
}

function helperDeclaresMax(call: ts.CallExpression, source: ts.SourceFile): boolean {
  if (!ts.isIdentifier(call.expression)) return false;
  const helperName = call.expression.text;
  const declarations = source.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === helperName
  );
  if (declarations.length !== 1 || !declarations[0]!.body) return false;
  const returns: ts.Expression[] = [];
  function visit(node: ts.Node): void {
    if (node !== declarations[0] && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
    ts.forEachChild(node, visit);
  }
  visit(declarations[0]!);
  return returns.length > 0
    && returns.every((expression) => expressionDeclaresMax(expression, declarations[0]!));
}

function constructorDeclaresMax(node: ts.NewExpression, source: ts.SourceFile): boolean {
  const options = node.arguments?.[0];
  if (!options) return false;
  return ts.isCallExpression(options)
    ? helperDeclaresMax(options, source)
    : expressionDeclaresMax(options, source);
}

describe("adversarial: PostgreSQL pools always declare a source budget", () => {
  test("every new SQL under packages declares max", () => {
    const omissions: string[] = [];
    for (const path of sourceFiles(packagesRoot)) {
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node): void {
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
          && node.expression.text === "SQL" && !constructorDeclaresMax(node, source)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          omissions.push(`${path.slice(packagesRoot.length + 1)}:${line}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(omissions).toEqual([]);
  });
});
