import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
test('signup focuses the step heading after forward and backward changes without initial autofocus', () => {
  const s = readFileSync(new URL('../app/auth-form.tsx', import.meta.url), 'utf8');
  assert.match(s, /const previousSignupStepRef = useRef\(signupStep\)/);
  assert.match(s, /if \(previousSignupStepRef.current === signupStep\) return/);
  assert.match(s, /previousSignupStepRef.current = signupStep;\s*if \(!isLogin\) stepHeadingRef.current\?\.focus\(\)/);
  assert.match(s, /\}, \[isLogin, signupStep\]\)/);
  assert.doesNotMatch(s, /requestAnimationFrame\(\(\) => stepHeadingRef/);
  assert.match(s, /ref=\{stepHeadingRef\} tabIndex=\{-1\}/);
});