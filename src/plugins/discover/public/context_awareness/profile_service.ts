/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/* eslint-disable max-classes-per-file */

import type { ComposableProfile, PartialProfile } from './composable_profile';
import type { Profile } from './types';

export type ResolveProfileResult<TContext> =
  | { isMatch: true; context: TContext }
  | { isMatch: false };

export type ContextWithProfileId<TContext> = TContext & { profileId: string };

export interface BaseProfileProvider<TProfile extends PartialProfile> {
  profileId: string;
  profile: ComposableProfile<TProfile>;
  /**
   * isExperimental Flag can be used for any profile which is under development and should not be enabled by default.
   *
   * Experimental profiles can still be enabled in kibana config with option `discover.experimental.enabledProfiles` as shown in example below:
   *
   * ```yaml
   * discover.experimental.enabledProfiles:
   *   - example-root-profile
   *   - example-data-source-profile
   * ```
   */
  isExperimental?: boolean;
}

export interface ProfileProvider<TProfile extends PartialProfile, TParams, TContext>
  extends BaseProfileProvider<TProfile> {
  resolve: (params: TParams) => ResolveProfileResult<TContext>;
}

export interface AsyncProfileProvider<TProfile extends PartialProfile, TParams, TContext>
  extends BaseProfileProvider<TProfile> {
  resolve: (
    params: TParams
  ) => ResolveProfileResult<TContext> | Promise<ResolveProfileResult<TContext>>;
}

const EMPTY_PROFILE = {};

export abstract class BaseProfileService<TProvider extends BaseProfileProvider<{}>, TContext> {
  protected readonly providers: TProvider[] = [];

  protected constructor(public readonly defaultContext: ContextWithProfileId<TContext>) {}

  public registerProvider(provider: TProvider) {
    this.providers.push(provider);
  }

  public getProfile(context: ContextWithProfileId<TContext>): ComposableProfile<Profile> {
    const provider = this.providers.find((current) => current.profileId === context.profileId);
    return provider?.profile ?? EMPTY_PROFILE;
  }
}

export class ProfileService<
  TProfile extends PartialProfile,
  TParams,
  TContext
> extends BaseProfileService<ProfileProvider<TProfile, TParams, TContext>, TContext> {
  public resolve(params: TParams) {
    for (const provider of this.providers) {
      const result = provider.resolve(params);

      if (result.isMatch) {
        return {
          ...result.context,
          profileId: provider.profileId,
        };
      }
    }

    return this.defaultContext;
  }
}

export class AsyncProfileService<
  TProfile extends PartialProfile,
  TParams,
  TContext
> extends BaseProfileService<AsyncProfileProvider<TProfile, TParams, TContext>, TContext> {
  public async resolve(params: TParams) {
    for (const provider of this.providers) {
      const result = await provider.resolve(params);

      if (result.isMatch) {
        return {
          ...result.context,
          profileId: provider.profileId,
        };
      }
    }

    return this.defaultContext;
  }
}
