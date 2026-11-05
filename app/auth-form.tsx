"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "../lib/auth-client";
import { createPolicyConsentFields } from "../lib/policy-consent";
import { formatUsPhone } from "../lib/phone";
import { getGoogleSignInErrorMessage } from "../lib/oauth-error";
import { normalizeAccountLocation } from "../lib/account-location";
import UiIcon from "@/components/ui-icon";
import CustomSelect from "@/components/custom-select";
import { recordProviderSignupFailed, recordProviderSignupStarted, recordProviderSignupSubmitted, signupFailureCategory } from "@/components/provider-signup-actions";

type SocialProvider = "google";

export default function AuthForm({ mode, redirectTo = "/account", socialProviders, oauthError, oauthErrorDescription }: { mode: "login" | "signup"; redirectTo?: string; socialProviders: Record<SocialProvider, boolean>; oauthError?: string; oauthErrorDescription?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [birthMonth, setBirthMonth] = useState("");
  const [birthDay, setBirthDay] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acknowledgedPrivacy, setAcknowledgedPrivacy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<SocialProvider | null>(null);
  const [signupStep, setSignupStep] = useState<1 | 2 | 3>(1);
  const [signupMethod, setSignupMethod] = useState<"email" | SocialProvider>("email");
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const isLogin = mode === "login";
  const isProviderIntent = redirectTo === "/providers/join" || redirectTo.startsWith("/providers/join?") || redirectTo.startsWith("/provider/");
  const hasRequiredConsents = acceptedTerms && acknowledgedPrivacy;
  const dateOfBirth = birthYear && birthMonth && birthDay ? `${birthYear}-${birthMonth.padStart(2, "0")}-${birthDay.padStart(2, "0")}` : "";
  const birthDays = useMemo(() => {
    const month = Number(birthMonth);
    const year = Number(birthYear);
    const daysInMonth = month ? new Date(Date.UTC(year || 2000, month, 0)).getUTCDate() : 31;
    return Array.from({ length: daysInMonth }, (_, index) => String(index + 1));
  }, [birthMonth, birthYear]);

  useEffect(() => {
    if (mode === "signup" && isProviderIntent) recordProviderSignupStarted();
  }, [isProviderIntent, mode]);

  async function confirmAgeEligibility() {
    if (!dateOfBirth) {
      setError("Enter your date of birth.");
      return false;
    }
    const response = await fetch("/api/age-eligibility", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dateOfBirth }),
    }).catch(() => null);
    if (!response) {
      if (isProviderIntent) recordProviderSignupFailed("unknown", "network");
      setError("We could not confirm your eligibility. Check your connection and try again.");
      return false;
    }
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) {
      if (isProviderIntent) recordProviderSignupFailed("unknown", "age_eligibility");
      setError(payload?.error ?? "We could not confirm your eligibility. Please try again.");
      return false;
    }
    setError("");
    return true;
  }

  async function recordPolicyConsent() {
    const response = await fetch("/api/policy-consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ termsAccepted: acceptedTerms, privacyAcknowledged: acknowledgedPrivacy }),
    }).catch(() => null);
    if (!response) {
      if (isProviderIntent) recordProviderSignupFailed(signupMethod, "network");
      setError("We could not record your agreement. Check your connection and try again.");
      return false;
    }
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) {
      if (isProviderIntent) recordProviderSignupFailed(signupMethod, "agreement");
      setError(payload?.error ?? "We could not record your agreement. Please try again.");
      return false;
    }
    return true;
  }

  async function showSignupStepTwo() {
    if (!await confirmAgeEligibility()) return;
    setSignupStep(2);
    requestAnimationFrame(() => stepHeadingRef.current?.focus());
  }

  function showSignupStepThree(method: "email" | SocialProvider) {
    if (method === "email") {
      const phoneDigits = phone.replace(/\D/g, "");
      if (!name.trim() || !email.includes("@") || (phoneDigits.length > 0 && phoneDigits.length !== 10) || password.length < 12) {
        if (isProviderIntent) recordProviderSignupFailed("email", "validation");
        setError("Enter your name, a valid email address, an optional 10-digit phone number, and a password with at least 12 characters.");
        return;
      }
    }
    setError("");
    setSignupMethod(method);
    setSignupStep(3);
    requestAnimationFrame(() => stepHeadingRef.current?.focus());
  }

  function showSignupStepOne() {
    setError("");
    setSignupStep(1);
    setSignupMethod("email");
  }

  function showSignupStepTwoAgain() {
    setError("");
    setSignupStep(2);
    setSignupMethod("email");
  }

  async function continueWith(provider: SocialProvider) {
    if (!socialProviders[provider]) return;
    if (!isLogin && signupStep === 1) {
      await showSignupStepTwo();
      return;
    }
    if (!isLogin && signupStep === 2) {
      showSignupStepThree(provider);
      return;
    }
    if (!isLogin && !hasRequiredConsents) {
      if (isProviderIntent) recordProviderSignupFailed(provider, "agreement");
      setError("Complete all required agreements before creating an account.");
      return;
    }
    if (!isLogin && !await recordPolicyConsent()) return;
    if (!isLogin) {
      const normalized = normalizeAccountLocation({ city, state, postalCode, country: "United States" });
      if ((!remoteOnly || isProviderIntent) && !normalized.location) {
        if (isProviderIntent) recordProviderSignupFailed(provider, "location");
        setError(normalized.error ?? "Enter your city, state, and ZIP code before creating an account.");
        return;
      }
      if (normalized.location) sessionStorage.setItem("bubsbookings-pending-account-location", JSON.stringify(normalized.location));
      else sessionStorage.removeItem("bubsbookings-pending-account-location");
    }

    setError("");
    setSocialLoading(provider);
    if (!isLogin && isProviderIntent) await recordProviderSignupSubmitted(provider);
    const errorCallbackURL = `/login?oauthError=1&redirect=${encodeURIComponent(redirectTo)}`;
    const newUserCallbackURL = `/account/settings?welcome=1&redirect=${encodeURIComponent(redirectTo)}`;
    const result = await authClient.signIn.social({
      provider,
      callbackURL: redirectTo,
      errorCallbackURL,
      newUserCallbackURL,
      requestSignUp: !isLogin,
    }).catch(() => null);
    if (!result) {
      setSocialLoading(null);
      if (!isLogin && isProviderIntent) recordProviderSignupFailed(provider, "network");
      setError("We could not connect to Google. Check your connection and try again.");
      return;
    }
    const { error: authError } = result;
    if (authError) {
      setSocialLoading(null);
      if (!isLogin && isProviderIntent) recordProviderSignupFailed(provider, signupFailureCategory(authError));
      setError(authError.message ?? "We could not continue with Google.");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isLogin && signupStep === 1) {
      await showSignupStepTwo();
      return;
    }
    if (!isLogin && signupStep === 2) {
      showSignupStepThree("email");
      return;
    }
    if (!isLogin && signupMethod === "google") {
      await continueWith("google");
      return;
    }
    const phoneDigits = phone.replace(/\D/g, "");
    const normalizedLocation = isLogin ? null : normalizeAccountLocation({ city, state, postalCode, country: "United States" });
    if (!isLogin && (!remoteOnly || isProviderIntent) && !normalizedLocation?.location) {
      if (isProviderIntent) recordProviderSignupFailed("email", "location");
      setError(normalizedLocation?.error ?? "Enter your city, state, and ZIP code.");
      return;
    }
    if ((!isLogin && (!name.trim() || (phoneDigits.length > 0 && phoneDigits.length !== 10) || !hasRequiredConsents || password.length < 12)) || !email.includes("@") || (isLogin && password.length === 0)) {
      if (!isLogin && isProviderIntent) recordProviderSignupFailed("email", "validation");
      setError("Enter valid account details. If provided, phone numbers need 10 digits. New passwords need at least 12 characters.");
      return;
    }

    setError("");
    setLoading(true);

    if (isLogin) {
      sessionStorage.setItem("bookme-post-login-redirect", redirectTo);
      const { data, error: authError } = await authClient.signIn.email({ email, password, rememberMe });
      setLoading(false);
      if (authError) {
        setError(authError.message ?? "We could not log you in. Check your details and try again.");
        return;
      }
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) return;
      sessionStorage.removeItem("bookme-post-login-redirect");
      router.push(redirectTo);
      router.refresh();
      return;
    }

    if (!await recordPolicyConsent()) {
      setLoading(false);
      return;
    }

    if (isProviderIntent) await recordProviderSignupSubmitted("email");
    const signUpResult = await authClient.signUp.email({
      email,
      password,
      name: name.trim(),
      phone: phone.trim(),
      city: normalizedLocation?.location?.city ?? "",
      state: normalizedLocation?.location?.state ?? "",
      postalCode: normalizedLocation?.location?.postalCode ?? "",
      country: normalizedLocation?.location?.country ?? "United States",
      ...createPolicyConsentFields(),
      callbackURL: redirectTo,
    }).catch(() => null);
    setLoading(false);
    if (!signUpResult) {
      if (isProviderIntent) recordProviderSignupFailed("email", "network");
      setError("We could not create your account. Check your connection and try again.");
      return;
    }
    const { data: signUpData, error: authError } = signUpResult;
    if (authError) {
      if (isProviderIntent) recordProviderSignupFailed("email", signupFailureCategory(authError));
      setError(authError.message ?? "We could not create your account. Please try again.");
      return;
    }
    if (!(signUpData as { token?: string | null } | null)?.token) {
      router.push(`/check-email?redirect=${encodeURIComponent(redirectTo)}`);
      return;
    }
    if (!rememberMe) {
      await authClient.signOut();
      const { error: sessionError } = await authClient.signIn.email({ email, password, rememberMe: false });
      if (sessionError) {
        setError(sessionError.message ?? "Your account was created, but we could not start the session. Please log in.");
        return;
      }
    }
    router.push(redirectTo);
    router.refresh();
  }

  const inputClass = "w-full rounded-2xl border border-[#183126]/15 bg-[#faf9f5] px-4 py-3.5 text-base outline-none transition focus:border-[#4d725d] focus:ring-2 focus:ring-[#4d725d]/10";

  return (
    <div className="w-full max-w-md rounded-[2rem] border border-[#183126]/10 bg-white p-6 shadow-[0_24px_70px_rgba(24,49,38,.14)] sm:p-9">
      <div className="text-center">
        <p className="text-xs font-bold uppercase tracking-[.16em] text-[#687b70]">{isProviderIntent ? "Provider setup" : isLogin ? "Welcome back" : "Join BubsBookings"}</p>
        <h1 className="mt-2 text-3xl font-bold tracking-[-.04em]">{isProviderIntent ? (isLogin ? "Log in to continue provider setup" : "Create your provider account") : isLogin ? "Log in to your account" : "Create your account"}</h1>
        <p className="mt-3 text-sm leading-6 text-[#718078]">{isProviderIntent ? "Set up your provider profile, services, availability, and Stripe payouts after you sign in." : isLogin ? "Manage bookings and connect with your favorite providers." : "Find local or remote service providers and keep every booking in one place."}</p>
      </div>

      {!isLogin && <div className="mt-6" aria-label={`Signup step ${signupStep} of 3`}><div className="flex items-center gap-2" aria-hidden="true"><span className="h-1.5 flex-1 rounded-full bg-[#183126]" /><span className={`h-1.5 flex-1 rounded-full ${signupStep >= 2 ? "bg-[#183126]" : "bg-[#dfe6dc]"}`} /><span className={`h-1.5 flex-1 rounded-full ${signupStep === 3 ? "bg-[#183126]" : "bg-[#dfe6dc]"}`} /></div><h2 ref={stepHeadingRef} tabIndex={-1} className="mt-3 text-sm font-bold outline-none">Step {signupStep} of 3 · {signupStep === 1 ? "Age eligibility" : signupStep === 2 ? "Account details" : "Preferences and agreements"}</h2><p className="mt-1 text-xs leading-5 text-[#718078]">{signupStep === 1 ? "Confirm your age before entering account details. We do not store your full date of birth." : signupStep === 2 ? "Enter your account details, then continue." : isProviderIntent ? "Add your general location and accept the required agreements to continue provider setup." : signupMethod === "google" ? "Choose your discovery preference and accept the required agreements before continuing with Google." : "Choose your discovery preference and accept the required agreements to finish."}</p></div>}

      {!isLogin && signupStep === 2 && <div className="mt-7">
        <SocialButton enabled={socialProviders.google} loading={socialLoading === "google"} disabled={Boolean(socialLoading)} onClick={() => void continueWith("google")} />
      </div>}
      {!isLogin && signupStep === 2 && <div className="my-6 flex items-center gap-3"><span className="h-px flex-1 bg-[#183126]/10" /><span className="text-xs text-[#89958f]">or continue with email</span><span className="h-px flex-1 bg-[#183126]/10" /></div>}

      <form onSubmit={submit} className="space-y-4">
        {!isLogin && signupStep === 1 && <DateOfBirthFields required month={birthMonth} day={birthDay} year={birthYear} days={birthDays} onMonthChange={(value) => { setBirthMonth(value); if (birthDay && Number(birthDay) > new Date(Date.UTC(Number(birthYear) || 2000, Number(value), 0)).getUTCDate()) setBirthDay(""); }} onDayChange={setBirthDay} onYearChange={(value) => { setBirthYear(value); if (birthDay && birthMonth && Number(birthDay) > new Date(Date.UTC(Number(value), Number(birthMonth), 0)).getUTCDate()) setBirthDay(""); }} helpText="You must be at least 18 years old to use BubsBookings. We use this only to confirm eligibility and do not store your full date of birth." inputClass={inputClass} />}
        {isLogin && <><SocialButton enabled={socialProviders.google} loading={socialLoading === "google"} disabled={Boolean(socialLoading)} onClick={() => void continueWith("google")} /><div className="flex items-center gap-3"><span className="h-px flex-1 bg-[#183126]/10" /><span className="text-xs text-[#89958f]">or continue with email</span><span className="h-px flex-1 bg-[#183126]/10" /></div></>}
        {!isLogin && signupStep === 2 && <label className="block"><span className="mb-2 block text-sm font-bold">Full name</span><input required autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Your full name" className={inputClass} /></label>}
        {(isLogin || signupStep === 2) && <label className="block"><span className="mb-2 block text-sm font-bold">Email address</span><input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" className={inputClass} /></label>}
        {!isLogin && signupStep === 3 && <fieldset className="rounded-2xl border border-[#183126]/10 bg-[#faf9f5] p-4"><legend className="px-1 text-sm font-bold">Service discovery</legend><p className="mb-4 text-xs leading-5 text-[#718078]">A general location personalizes local discovery. It is separate from a booking address or provider service area.</p>{!isProviderIntent && <label className="mb-4 flex cursor-pointer items-start gap-3 rounded-xl bg-white p-3"><input type="checkbox" checked={remoteOnly} onChange={(event) => setRemoteOnly(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#183126]" /><span className="text-sm font-semibold">I only need remote services right now<span className="mt-1 block text-xs font-normal leading-5 text-[#718078]">Skip location for now. You can add one later for nearby recommendations.</span></span></label>}{(!remoteOnly || isProviderIntent) && <div className="grid gap-4"><label className="block"><span className="mb-2 block text-sm font-bold">City</span><input required autoComplete="address-level2" value={city} onChange={(event) => setCity(event.target.value)} placeholder="Seattle" className={inputClass} /></label><div className="grid grid-cols-[minmax(0,.75fr)_minmax(0,1.25fr)] gap-3"><label className="block"><span className="mb-2 block text-sm font-bold">State</span><input required maxLength={2} autoComplete="address-level1" value={state} onChange={(event) => setState(event.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} placeholder="WA" className={inputClass} /></label><label className="block"><span className="mb-2 block text-sm font-bold">ZIP code</span><input required inputMode="numeric" maxLength={10} pattern="[0-9]{5}(-[0-9]{4})?" autoComplete="postal-code" value={postalCode} onChange={(event) => setPostalCode(event.target.value.replace(/[^0-9-]/g, ""))} placeholder="98101" className={inputClass} /></label></div><label className="block"><span className="mb-2 block text-sm font-bold">Country</span><input readOnly autoComplete="country-name" value="United States" className={`${inputClass} cursor-not-allowed text-[#718078]`} /></label></div>}</fieldset>}
        {!isLogin && signupStep === 2 && <label className="block"><span className="mb-2 block text-sm font-bold">Phone number <span className="font-normal text-[#718078]">(optional)</span></span><input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(formatUsPhone(event.target.value))} placeholder="(425) 555-0123" className={inputClass} /><span className="mt-2 block text-xs text-[#849189]">Used for booking updates and provider communication.</span></label>}
        {(isLogin || signupStep === 2) && <label className="block"><span className="mb-2 flex items-center justify-between text-sm font-bold">Password {isLogin && <Link href="/forgot-password" className="rounded-full px-2 py-1 text-xs text-[#5a7563] underline decoration-[#c7bb41] decoration-2 underline-offset-4 transition hover:bg-[#eee25a]">Forgot password?</Link>}</span><input required type="password" minLength={isLogin ? 1 : 12} maxLength={128} autoComplete={isLogin ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={isLogin ? "Your password" : "At least 12 characters"} className={inputClass} /></label>}
        {(isLogin || signupStep === 2) && <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-[#183126]/10 bg-[#faf9f5] px-4 py-3"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} className="h-4 w-4 accent-[#183126]" /><span className="text-sm font-semibold">Keep me signed in on this device</span></label>}
        {!isLogin && signupStep === 3 && <div className="space-y-2 rounded-2xl border border-[#183126]/10 bg-[#faf9f5] p-4"><p className="text-xs font-bold uppercase tracking-[.12em] text-[#687b70]">Required agreements</p><label className="flex cursor-pointer items-start gap-3"><input type="checkbox" required checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#183126]" /><span className="text-xs leading-5 text-[#66776e]">I have read and agree to the <Link href="/terms" target="_blank" className="font-bold underline">Terms of Service</Link>.</span></label><label className="flex cursor-pointer items-start gap-3"><input type="checkbox" required checked={acknowledgedPrivacy} onChange={(event) => setAcknowledgedPrivacy(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#183126]" /><span className="text-xs leading-5 text-[#66776e]">I acknowledge the <Link href="/privacy" target="_blank" className="font-bold underline">Privacy Policy</Link> and <Link href="/ai-transparency" target="_blank" className="font-bold underline">AI &amp; Safety disclosure</Link>.</span></label></div>}
        {(error || oauthError) && <p role="alert" className="rounded-xl bg-[#fff1e8] px-3 py-2.5 text-xs font-semibold leading-5 text-[#9a4e25]">{error || getGoogleSignInErrorMessage(oauthError, oauthErrorDescription)}</p>}
        {!isLogin && signupStep === 3 && <p className="text-xs leading-5 text-[#66776e]">By creating an account, you agree to the <Link href="/terms" target="_blank" className="font-bold underline">Terms of Service</Link> and acknowledge the <Link href="/privacy" target="_blank" className="font-bold underline">Privacy Policy</Link>, including how BubsBookings uses your account and location information.</p>}
        {!isLogin && signupStep === 2 && <button type="button" onClick={showSignupStepOne} className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-[#183126]/15 bg-white px-6 py-3 text-sm font-bold text-[#52695d] transition hover:bg-[#e7efe3]"><UiIcon name="arrow-left" className="h-4 w-4" />Back to age eligibility</button>}
        {!isLogin && signupStep === 3 && <button type="button" onClick={showSignupStepTwoAgain} className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-[#183126]/15 bg-white px-6 py-3 text-sm font-bold text-[#52695d] transition hover:bg-[#e7efe3]"><UiIcon name="arrow-left" className="h-4 w-4" />Back to signup options</button>}
        <button type="submit" disabled={loading || Boolean(socialLoading) || (!isLogin && signupStep === 3 && !hasRequiredConsents)} className="w-full rounded-full bg-[#eee25a] px-6 py-4 font-bold text-[#183126] transition hover:bg-[#f5ea6b] disabled:cursor-not-allowed disabled:opacity-60">{loading || socialLoading ? "Please wait…" : isLogin ? "Log in" : signupStep === 1 ? "Continue" : signupStep === 2 ? "Next" : signupMethod === "google" ? "Continue with Google" : "Create account"}</button>
      </form>

      <p className="mt-6 text-center text-sm text-[#74837b]">{isLogin ? "New to BubsBookings?" : "Already have an account?"} <Link href={`${isLogin ? "/signup" : "/login"}${redirectTo !== "/account" ? `?redirect=${encodeURIComponent(redirectTo)}` : ""}`} className="font-bold text-[#183126] underline decoration-[#c7bb41] decoration-2 underline-offset-4">{isLogin ? "Sign up" : "Log in"}</Link></p>
      {!isLogin && <p className="mt-5 text-center text-[11px] leading-5 text-[#89958f]">BubsBookings accounts are for adults age 18 or older.</p>}
    </div>
  );
}

function DateOfBirthFields({ required, month, day, year, days, onMonthChange, onDayChange, onYearChange, helpText, inputClass }: { required: boolean; month: string; day: string; year: string; days: string[]; onMonthChange: (value: string) => void; onDayChange: (value: string) => void; onYearChange: (value: string) => void; helpText: string; inputClass: string }) {
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: currentYear - 1899 }, (_, index) => String(currentYear - index));
  const buttonClass = `${inputClass} min-w-0`;
  const monthOptions = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((label, index) => ({ value: String(index + 1), label }));
  return <fieldset className="block"><legend className="mb-2 text-sm font-bold">Date of birth</legend><div className="mx-auto grid w-full grid-cols-[minmax(0,1.25fr)_minmax(0,.8fr)_minmax(0,1fr)] gap-2 sm:gap-3"><CustomSelect required={required} ariaLabel="Birth month" value={month} onChange={onMonthChange} options={monthOptions} placeholder="Month" buttonClassName={buttonClass} /><CustomSelect required={required} ariaLabel="Birth day" value={day} onChange={onDayChange} options={days.map((value) => ({ value, label: value }))} placeholder="Day" buttonClassName={buttonClass} /><CustomSelect required={required} ariaLabel="Birth year" value={year} onChange={onYearChange} options={years.map((value) => ({ value, label: value }))} placeholder="Year" buttonClassName={buttonClass} /></div><span className="mt-2 block text-xs leading-5 text-[#718078]">{helpText}</span></fieldset>;
}

function SocialButton({ enabled, loading, disabled, onClick }: { enabled: boolean; loading: boolean; disabled: boolean; onClick: () => void }) {
  const name = "Google";
  return <button type="button" onClick={onClick} disabled={!enabled || disabled} title={enabled ? `Continue with ${name}` : `${name} sign-in is being configured`} className="flex w-full items-center justify-center rounded-2xl border border-[#183126]/15 px-4 py-3 text-sm font-bold transition hover:border-[#4d725d] hover:bg-[#e5eddf] disabled:cursor-not-allowed disabled:opacity-55"><GoogleIcon /><span className="ml-2">{loading ? "Opening…" : `Continue with ${name}`}</span></button>;
}

function GoogleIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.87h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.35Z"/><path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.42l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.39 13.9A6 6 0 0 1 6.08 12c0-.66.11-1.3.31-1.9V7.51H3.04A10 10 0 0 0 2 12c0 1.61.38 3.14 1.04 4.49l3.35-2.59Z"/><path fill="#EA4335" d="M12 5.97c1.47 0 2.79.5 3.83 1.5L18.7 4.6A9.63 9.63 0 0 0 12 2a10 10 0 0 0-8.96 5.51l3.35 2.59C7.18 7.73 9.39 5.97 12 5.97Z"/></svg>;
}
