"use client";

import { startTransition, useActionState } from "react";
import type { FormEvent } from "react";

type Action<State> = (prevState: Awaited<State>, formData: FormData) => State | Promise<State>;

/**
 * `useActionState` for forms whose fields must survive a validation error.
 *
 * React 19 resets an uncontrolled `<form action={fn}>` once the action
 * resolves — including when it returns `{ error }`. Driving the dispatch from
 * `onSubmit` instead (no `action` prop) keeps the user's input in place.
 */
export function usePersistentAction<State>(action: Action<State>, initial: Awaited<State>) {
  const [state, dispatch, pending] = useActionState(action, initial);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  };

  return { state, onSubmit, dispatch, pending };
}
