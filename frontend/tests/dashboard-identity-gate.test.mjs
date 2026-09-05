import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { shouldBlockForLegalName } from '../src/lib/legal-name-model.ts';
const require = createRequire(import.meta.url);

function renderGate(profile, programs = { programsLoaded: true, programsLoadError: null, refreshPrograms: async () => [] }) {
  const source = readFileSync(new URL('../src/app/(dashboard)/layout.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const result = { exports: {} };
  const passthrough = ({ children }) => children;
  const imports = {
    'next/navigation': { useRouter: () => ({}) },
    '@/lib/supabase/client': { createClient: () => ({}) },
    '@/lib/store-session-cookies': {},
    '@/components/dashboard-route-transition': { DashboardRouteTransition: passthrough },
    '@/components/dashboard-shell': { DashboardSlugBand: () => 'tenant-scope' },
    '@/components/dashboard-shell-readiness': { DashboardShellReadiness: () => null },
    '@/components/dashboard-identity-skeleton': { DashboardIdentitySkeleton: ({ error }) => error ? 'identity-error-retry' : 'neutral-workspace' },
    '@/components/sidebar': { Sidebar: () => 'tenant-navigation' },
    '@/components/theme-provider': { useTheme: () => ({ navigationPlacement: 'side' }) },
    '@/components/account/legal-name-blocking-screen': { LegalNameBlockingScreen: () => 'legal-name-form' },
    '@/lib/store': { StoreProvider: passthrough, useStudioStore: () => profile, useProgramStore: () => programs },
    '@/lib/legal-name-model': { shouldBlockForLegalName },
    '@/components/dashboard-shell.module.css': {},
  };
  new Function('require', 'module', 'exports', compiled)((name) => imports[name] ?? require(name), result, result.exports);
  return renderToStaticMarkup(React.createElement(result.exports.default, null, React.createElement('p', null, 'protected-records')));
}
const profile = { identityReady: false, staffProfilesAvailable: false, legalFirstName: '', legalLastName: '', currentRole: null, identityGeneration: 1, identityLoadError: null };
test('unknown identity receives neutral geometry without tenant navigation or protected content', () => {
  const html = renderGate(profile);
  assert.match(html, /neutral-workspace/);
  assert.doesNotMatch(html, /tenant-navigation|tenant-scope|protected-records|legal-name-form/);
});
test('identity errors offer retry without showing protected content', () => {
  const html = renderGate({ ...profile, identityLoadError: 'Unavailable' });
  assert.match(html, /identity-error-retry/);
  assert.doesNotMatch(html, /protected-records/);
});
test('authoritative incomplete legal name receives only the required form', () => {
  const html = renderGate({ ...profile, identityReady: true, staffProfilesAvailable: true });
  assert.match(html, /legal-name-form/);
  assert.doesNotMatch(html, /tenant-navigation|protected-records/);
});
test('authoritative named profile retains navigation and content', () => {
  const html = renderGate({ ...profile, identityReady: true, staffProfilesAvailable: true, legalFirstName: 'Test', legalLastName: 'Person', currentRole: 'admin' });
  assert.match(html, /tenant-navigation/);
  assert.match(html, /protected-records/);
  assert.doesNotMatch(html, /neutral-workspace|legal-name-form/);
});

test('authoritative legacy profile without legal-name schema retains its existing access', () => {
  const html = renderGate({ ...profile, identityReady: true, currentRole: 'admin' });
  assert.match(html, /tenant-navigation/);
  assert.match(html, /protected-records/);
  assert.doesNotMatch(html, /neutral-workspace|legal-name-form/);
});


test('program metadata warnings stay behind identity and legal-name gates', () => {
  const unavailablePrograms = { programsLoaded: false, programsLoadError: 'Metadata unavailable', refreshPrograms: async () => [] };
  assert.doesNotMatch(renderGate(profile, unavailablePrograms), /Program options are unavailable/);
  assert.doesNotMatch(renderGate({ ...profile, identityReady: true, staffProfilesAvailable: true }, unavailablePrograms), /Program options are unavailable/);
  assert.match(renderGate({ ...profile, identityReady: true, currentRole: 'admin' }, unavailablePrograms), /Program options are unavailable/);
});
