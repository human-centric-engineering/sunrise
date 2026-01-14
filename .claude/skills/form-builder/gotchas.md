# Form Builder - Gotchas & Common Pitfalls

## Critical Issues

### 1. Form Submission Type Safety

**Problem:** TypeScript complains about form submission handler

**Wrong:**

```typescript
<form onSubmit={handleSubmit(onSubmit)}>
```

**Correct:**

```typescript
<form onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
```

**Why:** The `void` operator is needed to satisfy React's event handler typing when handleSubmit returns a Promise.

---

### 2. Missing Default Values

**Problem:** Form behaves unpredictably, uncontrolled to controlled warnings

**Wrong:**

```typescript
useForm<ProfileInput>({
  resolver: zodResolver(profileSchema),
});
```

**Correct:**

```typescript
useForm<ProfileInput>({
  resolver: zodResolver(profileSchema),
  defaultValues: {
    name: '',
    email: '',
    bio: '',
    // ALL fields must be present
  },
});
```

**Why:** Without defaults, fields start as `undefined` (uncontrolled) then become controlled when typing begins.

---

### 3. Watch vs Register Confusion

**Problem:** Password strength meter not updating, or field not submitting

**Wrong:**

```typescript
const password = watch('password');
<Input value={password} onChange={...} />  // Don't use value/onChange manually!
```

**Correct:**

```typescript
const password = watch('password'); // Only for reading value
<Input {...register('password')} /> // register() handles value/onChange
<PasswordStrength password={password} /> // Pass watched value to meter
```

**Why:** `register()` returns the necessary props for controlled input. Using `watch()` with manual value/onChange breaks the form state.

---

### 4. useSearchParams Hydration Issues

**Problem:** Hydration mismatch errors when reading URL params

**Wrong:**

```typescript
useEffect(() => {
  const params = useSearchParams(); // Hook inside effect
  const token = params.get('token');
}, []);
```

**Correct:**

```typescript
const searchParams = useSearchParams(); // Top level, outside effects
const token = searchParams.get('token'); // Read outside effect

useEffect(() => {
  // Use token here
}, [token]);
```

**Why:** Hooks must be called at the top level. Reading search params in effects can cause hydration mismatches.

---

### 5. Not Disabling Inputs During Loading

**Problem:** Users can submit multiple times, causing duplicate requests

**Wrong:**

```typescript
<Input {...register('email')} />
<Button type="submit">{isLoading ? 'Loading...' : 'Submit'}</Button>
```

**Correct:**

```typescript
<Input disabled={isLoading} {...register('email')} />
<Button type="submit" disabled={isLoading}>
  {isLoading ? 'Loading...' : 'Submit'}
</Button>
```

**Why:** All form elements should be disabled during submission to prevent double-submission.

---

### 6. Auth Client vs API Client Confusion

**Problem:** Using wrong client for form submission

**Auth Client (for authentication only):**

- `authClient.signIn.email()` - Login
- `authClient.signUp.email()` - Registration
- `authClient.signIn.social()` - OAuth

**API Client (for everything else):**

- `apiClient.post('/api/v1/users/me')` - Update profile
- `apiClient.patch('/api/v1/settings')` - Update settings
- `apiClient.post('/api/v1/users/invite')` - Admin invite

**Wrong:**

```typescript
// Don't use apiClient for login
await apiClient.post('/api/auth/sign-in', { body: { email, password } });
```

**Correct:**

```typescript
// Use authClient for login
await authClient.signIn.email({ email, password }, { onSuccess, onError });
```

---

### 7. Forgetting to Clear Error State

**Problem:** Old errors persist after re-submission

**Wrong:**

```typescript
const onSubmit = async (data) => {
  setIsLoading(true);
  try {
    await apiClient.post('/api/endpoint', { body: data });
  } catch (err) {
    setError(err.message);
  }
};
```

**Correct:**

```typescript
const onSubmit = async (data) => {
  setIsLoading(true);
  setError(null); // Clear previous error
  try {
    await apiClient.post('/api/endpoint', { body: data });
  } catch (err) {
    setError(err.message);
  }
};
```

---

### 8. Missing router.refresh() After Success

**Problem:** Page doesn't update after successful form submission

**Wrong:**

```typescript
onSuccess: () => {
  router.push('/dashboard');
};
```

**Correct:**

```typescript
onSuccess: () => {
  router.push('/dashboard');
  router.refresh(); // Refresh server components
};
```

**Why:** `router.refresh()` triggers a re-fetch of server components to reflect the new state.

---

### 9. Validation Mode Confusion

**Problem:** Errors showing immediately on all fields (annoying UX)

**Wrong:**

```typescript
useForm<Input>({
  resolver: zodResolver(schema),
  mode: 'all', // Validates all fields immediately
});
```

**Correct:**

```typescript
useForm<Input>({
  resolver: zodResolver(schema),
  mode: 'onTouched', // Only validates after user interacts
});
```

**Options:**

- `onTouched` - Validates after blur (recommended)
- `onChange` - Validates on every change
- `onBlur` - Validates on blur only
- `onSubmit` - Validates only on submit
- `all` - Validates continuously (not recommended)

---

### 10. Optional URL Fields

**Problem:** Empty string fails URL validation

**Wrong:**

```typescript
const schema = z.object({
  website: z.string().url().optional(), // Empty string fails url()
});
```

**Correct:**

```typescript
const schema = z.object({
  website: z.string().url().optional().or(z.literal('')), // Allow empty string
});
```

**Why:** An empty string `""` is not a valid URL, so you need to explicitly allow it.

---

### 11. Success State Not Disabling Button

**Problem:** User can click submit after success, before redirect completes

**Wrong:**

```typescript
<Button type="submit" disabled={isLoading}>Submit</Button>
```

**Correct:**

```typescript
<Button type="submit" disabled={isLoading || success}>Submit</Button>
```

---

### 12. OAuth Error Handling

**Problem:** OAuth errors in URL not displayed to user

**Missing error check:**

```typescript
export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  // OAuth errors from URL not handled
}
```

**Correct:**

```typescript
export function LoginForm() {
  const searchParams = useSearchParams();
  const oauthError = searchParams.get('error');
  const oauthErrorDescription = searchParams.get('error_description');

  const [error, setError] = useState<string | null>(null);

  // Display OAuth error OR form error
  const displayError =
    error || (oauthError ? oauthErrorDescription || 'OAuth sign-in failed' : null);

  return (
    <>
      {displayError && <FormError message={displayError} />}
      {/* rest of form */}
    </>
  );
}
```

---

## Best Practices Summary

1. Always use `mode: 'onTouched'` for forms
2. Always provide all `defaultValues`
3. Always disable inputs during `isLoading`
4. Always clear error before new submission
5. Always call `router.refresh()` after navigation
6. Use `authClient` for auth, `apiClient` for everything else
7. Use `void handleSubmit(onSubmit)(e)` for form submission
8. Check for OAuth errors in search params
9. Allow empty strings for optional URL fields
10. Disable button when `success` state is true
