import { FormError } from '@/components/forms/form-error';

/**
 * Says a form can't work here, for someone whose browser isn't running
 * JavaScript. Put it first inside a form that a signed-out visitor, or a
 * credential, goes through, so it is read before anything is typed.
 *
 * With no JavaScript, `method="post"` keeps a press of Submit out of the URL,
 * but nothing handles it: the page comes back empty, which reads as a failed
 * sign-in. A browser running scripts never shows this.
 */
export function NoScriptNotice() {
  return (
    <noscript>
      <FormError message="This form needs JavaScript. Turn it on in your browser, then reload this page." />
    </noscript>
  );
}
