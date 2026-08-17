import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { Building2, MailCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useNavigate } from 'react-router-dom'
import { z } from 'zod'

import { paths } from '@/app/routes/paths'
import { FullPageLoader } from '@/components/feedback/FullPageLoader'
import { Alert, Badge, Button, Field, Input } from '@/components/ui'
import { signIn, signUp } from '@/features/auth/api'
import { AuthLayout } from '@/features/auth/components/AuthLayout'
import { useAuth } from '@/features/auth/auth-context'
import { previewInvitation } from '@/features/team/api'
import { useAcceptInvitation } from '@/features/team/queries'
import { rememberWorkspaceSelection } from '@/features/workspace/WorkspaceProvider'
import { ROLE_LABELS } from '@/lib/authz/permissions'
import { toErrorMessage } from '@/lib/supabase/errors'

/**
 * Accepting an invitation.
 *
 * THE TOKEN
 *
 * It arrives in the URL fragment, which is the one part of a URL a browser never
 * sends to a server: it is absent from access logs, from any proxy in front of
 * the application, and from the Referer header of every request this page makes.
 * It is read once, held in React state, and stripped from the address bar
 * immediately so it does not survive a screenshot, a shared link or the back
 * button. It is never written to localStorage or sessionStorage — the durable
 * copy is the email, which is where it belongs, and re-opening that email is the
 * documented way back into this flow.
 *
 * THE THREE PEOPLE WHO ARRIVE HERE
 *
 *   Signed in as the invited address — one button.
 *   Signed in as somebody else — told so, and offered a way to switch. The
 *     invited address is shown masked; possession of a link is not a reason to
 *     hand out an address to whoever opens it.
 *   Signed out — signs in or creates an account here, without leaving the page,
 *     so the token never has to survive a redirect.
 *
 * A new account does not create an agency. `signUp` is called with no agency
 * name, and the database refuses to provision one for an address that has an
 * open invitation regardless of what the browser sends — so an invited person
 * cannot end up owning an empty agency they never asked for.
 */

const signInSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email address.').email('Enter a valid address.'),
  password: z.string().min(1, 'Enter your password.'),
})

const signUpSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Enter your name.').max(120, 'That name is too long.'),
    email: z.string().trim().min(1, 'Enter your email address.').email('Enter a valid address.'),
    password: z.string().min(8, 'Use at least 8 characters.').max(72, 'That is too long.'),
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Both passwords must match.',
    path: ['confirmPassword'],
  })

type SignInValues = z.infer<typeof signInSchema>
type SignUpValues = z.infer<typeof signUpSchema>

/** Reads the token out of the fragment and clears it from the address bar. */
function useInvitationToken(): string | null {
  const [token] = useState(() => {
    const hash = window.location.hash.replace(/^#/, '')
    const value = new URLSearchParams(hash).get('token')
    return value && value.length >= 20 ? value : null
  })

  useEffect(() => {
    if (!window.location.hash) return
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  }, [])

  return token
}

export function AcceptInvitePage() {
  const token = useInvitationToken()
  const { status, user, signOut } = useAuth()
  const navigate = useNavigate()
  const accept = useAcceptInvitation()

  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [formError, setFormError] = useState<string | null>(null)
  const [awaitingConfirmation, setAwaitingConfirmation] = useState<string | null>(null)

  const preview = useQuery({
    // Deliberately not keyed on the token: a cache entry keyed by a bearer
    // secret is a bearer secret sitting in memory under a predictable name.
    queryKey: ['invitation-preview'],
    queryFn: () => previewInvitation(token!),
    enabled: token !== null,
    retry: false,
    /*
     * Never cached and never reused. The key cannot include the token — a cache
     * entry keyed by a bearer secret is that secret sitting in memory under a
     * predictable name — so the key is constant, and a constant key would
     * otherwise serve one invitation's preview for another opened moments later.
     */
    staleTime: 0,
    gcTime: 0,
  })

  const signInForm = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '', password: '' },
  })
  const signUpForm = useForm<SignUpValues>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { fullName: '', email: '', password: '', confirmPassword: '' },
  })

  if (!token) {
    return (
      <AuthLayout
        title="This link is incomplete"
        description="An invitation link carries a code that is missing here."
        footer={
          <Link to={paths.signIn} className="text-brand-700 font-medium hover:underline">
            Go to sign in
          </Link>
        }
      >
        <Alert tone="caution" title="Open the link from your email">
          Copy the whole address, including everything after the # symbol. If it has been a while,
          ask whoever invited you to send a new one.
        </Alert>
      </AuthLayout>
    )
  }

  if (status === 'loading' || preview.isPending) {
    return <FullPageLoader label="Checking your invitation" />
  }

  if (preview.isError) {
    return (
      <AuthLayout
        title="This invitation is not valid"
        description="It may have been withdrawn, already used, or replaced by a newer one."
        footer={
          <Link to={paths.signIn} className="text-brand-700 font-medium hover:underline">
            Go to sign in
          </Link>
        }
      >
        <Alert tone="caution">
          Ask whoever invited you to send a new invitation. Nothing has changed about your account.
        </Alert>
      </AuthLayout>
    )
  }

  const invitation = preview.data
  const settled = invitation.state !== 'pending'

  const summary = (
    <div className="border-line bg-surface-inset rounded-lg border p-4">
      <div className="flex items-start gap-3">
        <Building2 className="text-brand-600 mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-[0.9375rem] leading-5 font-semibold break-words">
            {invitation.organizationName}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone="brand">{ROLE_LABELS[invitation.role]}</Badge>
            {invitation.invitedByName ? (
              <span className="text-ink-muted text-[0.75rem]">
                Invited by {invitation.invitedByName}
              </span>
            ) : null}
          </div>
          <p className="text-ink-subtle mt-1.5 text-[0.75rem] leading-4">
            Sent to {invitation.emailMasked}
            {invitation.expiresAt
              ? ` · expires ${new Date(invitation.expiresAt).toLocaleDateString()}`
              : ''}
          </p>
        </div>
      </div>
    </div>
  )

  if (settled) {
    return (
      <AuthLayout
        title="This invitation is no longer open"
        description={
          invitation.state === 'accepted'
            ? 'It has already been used.'
            : invitation.state === 'expired'
              ? 'It expired before it was used.'
              : 'It was withdrawn.'
        }
        footer={
          <Link to={paths.signIn} className="text-brand-700 font-medium hover:underline">
            Go to sign in
          </Link>
        }
      >
        <div className="space-y-4">
          {summary}
          <Alert tone="caution">
            Ask an administrator at {invitation.organizationName} to send a new invitation.
          </Alert>
        </div>
      </AuthLayout>
    )
  }

  // -------------------------------------------------------------- signed in
  if (status === 'authenticated' && user) {
    const join = () => {
      setFormError(null)
      accept.mutate(token, {
        onSuccess: (result) => {
          rememberWorkspaceSelection(user.id, result.organization_id)
          void navigate(paths.overview, { replace: true })
        },
        onError: (error) => setFormError(toErrorMessage(error)),
      })
    }

    return (
      <AuthLayout
        title="Join this agency"
        description="Your account keeps everything it already has."
        footer={
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-ink-muted hover:text-ink"
          >
            Sign in as somebody else
          </button>
        }
      >
        <div className="space-y-4">
          {summary}

          {formError ? <Alert tone="critical">{formError}</Alert> : null}

          <p className="text-ink-muted text-[0.8125rem] leading-5">
            You are signed in as <span className="text-ink font-medium">{user.email}</span>. If that
            is not the address this invitation was sent to, sign in as somebody else first.
          </p>

          <Button variant="primary" size="lg" fullWidth isLoading={accept.isPending} onClick={join}>
            Join {invitation.organizationName}
          </Button>
        </div>
      </AuthLayout>
    )
  }

  // ------------------------------------------------------- awaiting confirm
  if (awaitingConfirmation) {
    return (
      <AuthLayout
        title="Confirm your email"
        description="One step before you can join."
        footer={
          <Link to={paths.signIn} className="text-brand-700 font-medium hover:underline">
            Go to sign in
          </Link>
        }
      >
        <div className="space-y-4">
          {summary}
          <div className="border-line flex items-start gap-3 rounded-lg border p-4">
            <MailCheck className="text-brand-600 mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <div className="text-[0.8125rem] leading-5">
              <p>
                We sent a confirmation link to{' '}
                <span className="font-medium">{awaitingConfirmation}</span>. Open it to activate
                your account.
              </p>
              {/*
                The invitation email is the durable copy of the token, so the way
                back in is to open it again — no bearer secret has to survive in
                browser storage for this flow to work.
              */}
              <p className="text-ink-muted mt-2">
                Then come back to the invitation email and open its link again. Your invitation to{' '}
                {invitation.organizationName} is still waiting.
              </p>
            </div>
          </div>
        </div>
      </AuthLayout>
    )
  }

  // -------------------------------------------------------------- signed out
  const submitSignIn = signInForm.handleSubmit(async (values) => {
    setFormError(null)
    try {
      await signIn(values)
      // The session arrives through the auth listener and this component
      // re-renders into the signed-in branch above, token still in state.
    } catch (error) {
      setFormError(toErrorMessage(error))
    }
  })

  const submitSignUp = signUpForm.handleSubmit(async (values) => {
    setFormError(null)
    try {
      const result = await signUp(
        {
          fullName: values.fullName,
          email: values.email,
          password: values.password,
          confirmPassword: values.confirmPassword,
          // No agency name, no country, no currency: this person is joining one
          // that already exists and has all of those.
          organizationName: '',
          countryCode: '',
          defaultCurrency: '',
          timeZone: '',
        },
        // Back here after confirming, rather than to the generic callback that
        // would route somebody with no membership yet into "create an agency".
        paths.acceptInvite,
      )
      if (!result.hasSession) setAwaitingConfirmation(result.email)
    } catch (error) {
      setFormError(toErrorMessage(error))
    }
  })

  return (
    <AuthLayout
      title={mode === 'sign-in' ? 'Sign in to join' : 'Create your account'}
      description={`You have been invited to ${invitation.organizationName}.`}
      footer={
        mode === 'sign-in' ? (
          <>
            New here?{' '}
            <button
              type="button"
              onClick={() => {
                setMode('sign-up')
                setFormError(null)
              }}
              className="text-brand-700 font-medium hover:underline"
            >
              Create an account
            </button>
          </>
        ) : (
          <>
            Already have an account?{' '}
            <button
              type="button"
              onClick={() => {
                setMode('sign-in')
                setFormError(null)
              }}
              className="text-brand-700 font-medium hover:underline"
            >
              Sign in
            </button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {summary}

        {formError ? <Alert tone="critical">{formError}</Alert> : null}

        {mode === 'sign-in' ? (
          <form onSubmit={(event) => void submitSignIn(event)} className="space-y-4" noValidate>
            <Field label="Email" error={signInForm.formState.errors.email?.message} required>
              <Input
                type="email"
                autoComplete="email"
                autoFocus
                placeholder="you@agency.com"
                {...signInForm.register('email')}
              />
            </Field>
            <Field label="Password" error={signInForm.formState.errors.password?.message} required>
              <Input
                type="password"
                autoComplete="current-password"
                {...signInForm.register('password')}
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              fullWidth
              isLoading={signInForm.formState.isSubmitting}
            >
              Sign in and join
            </Button>
          </form>
        ) : (
          <form onSubmit={(event) => void submitSignUp(event)} className="space-y-4" noValidate>
            <Field label="Your name" error={signUpForm.formState.errors.fullName?.message} required>
              <Input autoComplete="name" autoFocus {...signUpForm.register('fullName')} />
            </Field>
            <Field
              label="Email"
              error={signUpForm.formState.errors.email?.message}
              hint="Use the address the invitation was sent to."
              required
            >
              <Input type="email" autoComplete="email" {...signUpForm.register('email')} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Password"
                error={signUpForm.formState.errors.password?.message}
                hint="At least 8 characters."
                required
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  {...signUpForm.register('password')}
                />
              </Field>
              <Field
                label="Confirm password"
                error={signUpForm.formState.errors.confirmPassword?.message}
                required
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  {...signUpForm.register('confirmPassword')}
                />
              </Field>
            </div>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              fullWidth
              isLoading={signUpForm.formState.isSubmitting}
            >
              Create account
            </Button>
            <p className="text-ink-subtle text-[0.75rem] leading-4">
              This creates an account and nothing else. You are joining{' '}
              {invitation.organizationName}, not starting an agency of your own.
            </p>
          </form>
        )}
      </div>
    </AuthLayout>
  )
}
