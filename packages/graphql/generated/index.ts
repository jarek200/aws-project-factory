export type Maybe<T> = T | null;
export type InputMaybe<T> = T | null | undefined;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
};

/** Lifecycle of closing a vended AWS account (factory automation). */
export type AccountClosureState =
  | 'CLOSED'
  | 'CLOSING'
  | 'NONE';

export type CreateProjectInput = {
  /** Pass an empty list to create only the GitHub monorepo; use provisionProjectAws later. */
  accounts: Array<ProjectAccountInput>;
  awsSignInUrl?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  githubOrg?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  slug: Scalars['String']['input'];
  templateRepo?: InputMaybe<Scalars['String']['input']>;
  websiteUrl?: InputMaybe<Scalars['String']['input']>;
};

/** Step Functions progress for account decommission (parallel to provisioning). */
export type DecommissionPhase =
  | 'CLOSE_ACCOUNT'
  | 'DISPATCH_DESTROY'
  | 'DONE'
  | 'FAILED'
  | 'IDLE'
  | 'TEARDOWN_BOOTSTRAP'
  | 'UNASSIGN_IDENTITY_CENTER';

export type GithubRepoOption = {
  __typename?: 'GithubRepoOption';
  fullName: Scalars['String']['output'];
  isTemplate: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  private: Scalars['Boolean']['output'];
};

export type Mutation = {
  __typename?: 'Mutation';
  /**
   * Start Step Functions decommission: optional GitHub monorepo destroy workflow, bootstrap IAM teardown,
   * Identity Center unassign, Organizations CloseAccount, then mark account CLOSED in DynamoDB.
   * Set runMonorepoTeardown to false to skip dispatching the repo workflow (no GitHub Actions permission needed for that step).
   */
  closeProjectAccount: Project;
  /**
   * Close an org member account without a factory project (or when not using project close): runs the same
   * decommission state machine with GitHub teardown skipped. Tracks progress on the ORG_ACCOUNT#… item.
   */
  closeStandaloneOrganizationAccount: OrganizationAccount;
  createProject: Project;
  deleteProject: Scalars['Boolean']['output'];
  /** Vend AWS accounts, OIDC, Identity Center, and GitHub deploy config for a REPO_ONLY project. */
  provisionProjectAws: Project;
  /**
   * Calls Organizations ListAccounts in the management account and upserts ORG_ACCOUNT# rows in AppTable.
   * Removes DynamoDB rows for accounts no longer in the organization.
   */
  syncOrganizationAccounts: OrganizationAccountSyncResult;
  /**
   * Lists repos visible to the GitHub App installation and deletes the caller's factory projects whose
   * confirmed githubUrl repo is no longer present (deleted or removed from the installation).
   * Skips projects still provisioning (GITHUB / ACCOUNTS / CONFIGURE, or REPO_ONLY without githubUrl).
   */
  syncProjectsWithGithub: ProjectGithubSyncResult;
  updateProject: Project;
  updateUserProfile?: Maybe<User>;
};


export type MutationCloseProjectAccountArgs = {
  accountId: Scalars['ID']['input'];
  projectId: Scalars['ID']['input'];
  runMonorepoTeardown?: InputMaybe<Scalars['Boolean']['input']>;
};


export type MutationCloseStandaloneOrganizationAccountArgs = {
  accountId: Scalars['ID']['input'];
};


export type MutationCreateProjectArgs = {
  input: CreateProjectInput;
};


export type MutationDeleteProjectArgs = {
  id: Scalars['ID']['input'];
};


export type MutationProvisionProjectAwsArgs = {
  input: ProvisionProjectAwsInput;
};


export type MutationUpdateProjectArgs = {
  id: Scalars['ID']['input'];
  input: UpdateProjectInput;
};


export type MutationUpdateUserProfileArgs = {
  input: UpdateUserInput;
};

/** Member (and management) accounts from AWS Organizations, synced into DynamoDB. */
export type OrganizationAccount = {
  __typename?: 'OrganizationAccount';
  accountId: Scalars['ID']['output'];
  arn?: Maybe<Scalars['String']['output']>;
  closedAt?: Maybe<Scalars['String']['output']>;
  /** App-managed lifecycle when closing outside a factory project (or mirrored from inventory). */
  closureState?: Maybe<AccountClosureState>;
  decommissionError?: Maybe<Scalars['String']['output']>;
  decommissionPhase?: Maybe<DecommissionPhase>;
  email?: Maybe<Scalars['String']['output']>;
  /** True for the organization management account (DescribeOrganization.MasterAccountId). */
  isManagementAccount: Scalars['Boolean']['output'];
  joinedMethod?: Maybe<Scalars['String']['output']>;
  joinedTimestamp?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  /** AWS Organizations account lifecycle (State API). Former Status is not exposed. */
  state?: Maybe<Scalars['String']['output']>;
  syncedAt: Scalars['String']['output'];
};

export type OrganizationAccountSyncResult = {
  __typename?: 'OrganizationAccountSyncResult';
  removed: Scalars['Int']['output'];
  upserted: Scalars['Int']['output'];
};

export type Project = {
  __typename?: 'Project';
  accounts: Array<ProjectAccount>;
  awsSignInUrl?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['String']['output'];
  decommissionError?: Maybe<Scalars['String']['output']>;
  decommissionExecutionArn?: Maybe<Scalars['String']['output']>;
  /** Active only while a member account closure is running or failed. */
  decommissionPhase?: Maybe<DecommissionPhase>;
  decommissionTargetAccountId?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  executionArn?: Maybe<Scalars['String']['output']>;
  githubOrg?: Maybe<Scalars['String']['output']>;
  githubUrl?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  provisioningPhase: ProvisioningPhase;
  provisioningProgress?: Maybe<Scalars['Int']['output']>;
  slug: Scalars['String']['output'];
  templateRepo?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['String']['output'];
  userId: Scalars['String']['output'];
  websiteUrl?: Maybe<Scalars['String']['output']>;
};

export type ProjectAccount = {
  __typename?: 'ProjectAccount';
  accountId?: Maybe<Scalars['String']['output']>;
  awsSignInUrl?: Maybe<Scalars['String']['output']>;
  closedAt?: Maybe<Scalars['String']['output']>;
  closureState?: Maybe<AccountClosureState>;
  email: Scalars['String']['output'];
  name: Scalars['String']['output'];
  roleArn?: Maybe<Scalars['String']['output']>;
};

export type ProjectAccountInput = {
  /** When set, bootstrap this existing Organizations member (skip CreateAccount). Must be 12 digits. */
  accountId?: InputMaybe<Scalars['String']['input']>;
  email: Scalars['String']['input'];
  name: Scalars['String']['input'];
};

export type ProjectGithubSyncResult = {
  __typename?: 'ProjectGithubSyncResult';
  /** Projects that had a confirmed githubUrl and were checked against the GitHub App installation. */
  checked: Scalars['Int']['output'];
  /** Projects deleted from AppTable because their repo is no longer visible to the installation. */
  removed: Scalars['Int']['output'];
  /** Projects skipped because provisioning is still in progress (or githubUrl not written yet). */
  skippedInProgress: Scalars['Int']['output'];
};

export type ProvisionProjectAwsInput = {
  accounts: Array<ProjectAccountInput>;
  projectId: Scalars['ID']['input'];
};

export type ProvisioningPhase =
  | 'ACCOUNTS'
  | 'CONFIGURE'
  | 'DONE'
  | 'DRAFT'
  | 'FAILED'
  | 'GITHUB'
  /** GitHub monorepo created; AWS accounts not provisioned yet (repo-first flow). */
  | 'REPO_ONLY';

export type Query = {
  __typename?: 'Query';
  getMyProfile?: Maybe<User>;
  /** Single inventory row; use to poll decommission UI after closeStandaloneOrganizationAccount. */
  getOrganizationAccount?: Maybe<OrganizationAccount>;
  getProject?: Maybe<Project>;
  /** Repositories visible to the configured GitHub App installation (for template selection). */
  listGithubReposForTemplate: Array<GithubRepoOption>;
  /** All accounts last synced from AWS Organizations into AppTable (run syncOrganizationAccounts to refresh). */
  listOrganizationAccounts: Array<OrganizationAccount>;
  listProjects: Array<Project>;
};


export type QueryGetOrganizationAccountArgs = {
  accountId: Scalars['ID']['input'];
};


export type QueryGetProjectArgs = {
  id: Scalars['ID']['input'];
};

export type UpdateProjectInput = {
  awsSignInUrl?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  githubUrl?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  websiteUrl?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateUserInput = {
  avatar?: InputMaybe<Scalars['String']['input']>;
  bio?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
};

export type User = {
  __typename?: 'User';
  avatar?: Maybe<Scalars['String']['output']>;
  bio?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['String']['output'];
  email: Scalars['String']['output'];
  name?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['String']['output'];
  userId: Scalars['ID']['output'];
  username: Scalars['String']['output'];
};
