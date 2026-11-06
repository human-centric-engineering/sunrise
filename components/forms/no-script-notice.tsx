import { FormError } from '@/components/forms/form-error';

/**
 * Says a form can't work here, for someone whose browser isn't running
 * JavaScript. Put it first inside a form a signed-out visitor uses, or that
 * changes a password, so it is read before anything is typed.
 *
 * With no JavaScript, `method="post"` keeps a press of Submit out of the URL,
 * but nothing handles it: the page comes back empty, which reads as a failed
 * sign-in. A browser with scripting on never shows this, including one whose
 * scripts failed to load (`.context/ui/form-errors.md`).
 */
export function NoScriptNotice() {
  return (
    <noscript>
      <FormError message="This form needs JavaScript. Turn it on in your browser, then reload this page." />
    </noscript>
  );
}
