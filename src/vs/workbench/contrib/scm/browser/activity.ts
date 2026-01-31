/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { basename } from 'vs/base/common/resources';
import { IDisposable, dispose, Disposable, DisposableStore, combinedDisposable, MutableDisposable } from 'vs/base/common/lifecycle';
import { Event } from 'vs/base/common/event';
import { VIEW_PANE_ID, ISCMService, ISCMRepository, ISCMViewService } from 'vs/workbench/contrib/scm/common/scm';
import { IActivityService, NumberBadge } from 'vs/workbench/services/activity/common/activity';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IStatusbarEntry, IStatusbarService, StatusbarAlignment as MainThreadStatusBarAlignment } from 'vs/workbench/services/statusbar/browser/statusbar';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { EditorResourceAccessor } from 'vs/workbench/common/editor';
import { IUriIdentityService } from 'vs/platform/uriIdentity/common/uriIdentity';
import { Schemas } from 'vs/base/common/network';
import { Iterable } from 'vs/base/common/iterator';

function getCount(repository: ISCMRepository): number {
	if (typeof repository.provider.count === 'number') {
		return repository.provider.count;
	} else {
		return repository.provider.groups.reduce<number>((r, g) => r + g.resources.length, 0);
	}
}

export class SCMStatusController implements IWorkbenchContribution {

	private statusBarDisposable: IDisposable = Disposable.None;
	private focusDisposable: IDisposable = Disposable.None;
	private focusedRepository: ISCMRepository | undefined = undefined;
	private readonly badgeDisposable = new MutableDisposable<IDisposable>();
	private readonly disposables = new DisposableStore();
	private repositoryDisposables = new Set<IDisposable>();

	constructor(
		@IActivityService private readonly activityService: IActivityService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ITitleService private readonly titleService: ITitleService
	) {
		super();

		this._activeRepositoryNameContextKey = ActiveRepositoryContextKeys.ActiveRepositoryName.bindTo(this.contextKeyService);
		this._activeRepositoryBranchNameContextKey = ActiveRepositoryContextKeys.ActiveRepositoryBranchName.bindTo(this.contextKeyService);

		this.titleService.registerVariables([
			{ name: 'activeRepositoryName', contextKey: ActiveRepositoryContextKeys.ActiveRepositoryName.key },
			{ name: 'activeRepositoryBranchName', contextKey: ActiveRepositoryContextKeys.ActiveRepositoryBranchName.key, }
		]);

		this._countBadgeConfig = observableConfigValue<'all' | 'focused' | 'off'>('scm.countBadge', 'all', this.configurationService);

		this._repositories = observableFromEvent(this,
			Event.any(this.scmService.onDidAddRepository, this.scmService.onDidRemoveRepository),
			() => this.scmService.repositories);

		this._activeRepositoryHistoryItemRefName = derived(reader => {
			const repository = this.scmViewService.activeRepository.read(reader);
			const historyProvider = repository?.provider.historyProvider.read(reader);
			const historyItemRef = historyProvider?.historyItemRef.read(reader);

			return historyItemRef?.name;
		});

		this._countBadgeRepositories = derived(this, reader => {
			switch (this._countBadgeConfig.read(reader)) {
				case 'all': {
					const repositories = this._repositories.read(reader);
					return [...Iterable.map(repositories, r => ({ provider: r.provider, resourceCount: this._getRepositoryResourceCount(r) }))];
				}
				case 'focused': {
					const repository = this.scmViewService.activeRepository.read(reader);
					return repository ? [{ provider: repository.provider, resourceCount: this._getRepositoryResourceCount(repository) }] : [];
				}
				case 'off':
					return [];
				default:
					throw new Error('Invalid countBadge setting');
			}
		});

		this._countBadge = derived(this, reader => {
			let total = 0;

			for (const repository of this._countBadgeRepositories.read(reader)) {
				const count = repository.provider.count?.read(reader);
				const resourceCount = repository.resourceCount.read(reader);

				total = total + (count ?? resourceCount);
			}

			return total;
		});

		this._register(autorunWithStore((reader, store) => {
			const countBadge = this._countBadge.read(reader);
			this._updateActivityCountBadge(countBadge, store);
		}));

		this._register(autorunWithStore((reader, store) => {
			const repository = this.scmViewService.activeRepository.read(reader);
			const commands = repository?.provider.statusBarCommands.read(reader);

			this._updateStatusBar(repository, commands ?? [], store);
		}));

		this._register(autorun(reader => {
			const repository = this.scmViewService.activeRepository.read(reader);
			const historyItemRefName = this._activeRepositoryHistoryItemRefName.read(reader);

			this._updateActiveRepositoryContextKeys(repository?.provider.name, historyItemRefName);
		}));
	}

	private _getRepositoryResourceCount(repository: ISCMRepository): IObservable<number> {
		return observableFromEvent(this, repository.provider.onDidChangeResources, () => /** @description repositoryResourceCount */ getRepositoryResourceCount(repository.provider));
	}

	private _updateActivityCountBadge(count: number, store: DisposableStore): void {
		if (count === 0) {
			return;
		}

		const badge = new NumberBadge(count, num => localize('scmPendingChangesBadge', '{0} pending changes', num));
		store.add(this.activityService.showViewActivity(VIEW_PANE_ID, { badge }));
	}

	private _updateStatusBar(repository: ISCMRepository | undefined, commands: readonly Command[], store: DisposableStore): void {
		if (!repository) {
			return;
		}

		const label = repository.provider.rootUri
			? `${basename(repository.provider.rootUri)} (${repository.provider.label})`
			: repository.provider.label;

		for (let index = 0; index < commands.length; index++) {
			const command = commands[index];
			const tooltip = `${label}${command.tooltip ? ` - ${command.tooltip}` : ''}`;

			// Get a repository agnostic name for the status bar action, derive this from the
			// first command argument which is in the form "git.<command>/<number>"
			let repoAgnosticActionName = command.arguments?.[0];
			if (repoAgnosticActionName && typeof repoAgnosticActionName === 'string') {
				repoAgnosticActionName = repoAgnosticActionName
					.substring(0, repoAgnosticActionName.lastIndexOf('/'))
					.replace(/^git\./, '');
				if (repoAgnosticActionName.length > 1) {
					repoAgnosticActionName = repoAgnosticActionName[0].toLocaleUpperCase() + repoAgnosticActionName.slice(1);
				}
			} else {
				repoAgnosticActionName = '';
			}

			const statusbarEntry: IStatusbarEntry = {
				name: localize('status.scm', "Source Control") + (repoAgnosticActionName ? ` ${repoAgnosticActionName}` : ''),
				text: command.title,
				ariaLabel: tooltip,
				tooltip,
				command: command.id ? command : undefined
			};

			store.add(index === 0 ?
				this.statusbarService.addEntry(statusbarEntry, `status.scm.${index}`, MainThreadStatusBarAlignment.LEFT, 10000) :
				this.statusbarService.addEntry(statusbarEntry, `status.scm.${index}`, MainThreadStatusBarAlignment.LEFT, { location: { id: `status.scm.${index - 1}`, priority: 10000 }, alignment: MainThreadStatusBarAlignment.RIGHT, compact: true })
			);
		}
	}

	private _updateActiveRepositoryContextKeys(repositoryName: string | undefined, branchName: string | undefined): void {
		this._activeRepositoryNameContextKey.set(repositoryName ?? '');
		this._activeRepositoryBranchNameContextKey.set(branchName ?? '');
	}
}

export class SCMActiveResourceContextKeyController extends Disposable implements IWorkbenchContribution {
	private readonly _repositories: IObservable<Iterable<ISCMRepository>>;

	private readonly _onDidRepositoryChange = new Emitter<void>();

	constructor(
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@ISCMService private readonly scmService: ISCMService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService
	) {
		super();

		const activeResourceHasChangesContextKey = new RawContextKey<boolean>('scmActiveResourceHasChanges', false, localize('scmActiveResourceHasChanges', "Whether the active resource has changes"));
		const activeResourceRepositoryContextKey = new RawContextKey<string | undefined>('scmActiveResourceRepository', undefined, localize('scmActiveResourceRepository', "The active resource's repository"));

		this._repositories = observableFromEvent(this,
			Event.any(this.scmService.onDidAddRepository, this.scmService.onDidRemoveRepository),
			() => this.scmService.repositories);

		this._store.add(autorunWithStore((reader, store) => {
			for (const repository of this._repositories.read(reader)) {
				store.add(Event.runAndSubscribe(repository.provider.onDidChangeResources, () => {
					this._onDidRepositoryChange.fire();
				}));
			}
		}));

		// Create context key providers which will update the context keys based on each groups active editor
		const hasChangesContextKeyProvider: IEditorGroupContextKeyProvider<boolean> = {
			contextKey: activeResourceHasChangesContextKey,
			getGroupContextKeyValue: (group) => this._getEditorHasChanges(group.activeEditor),
			onDidChange: this._onDidRepositoryChange.event
		};

		const repositoryContextKeyProvider: IEditorGroupContextKeyProvider<string | undefined> = {
			contextKey: activeResourceRepositoryContextKey,
			getGroupContextKeyValue: (group) => this._getEditorRepositoryId(group.activeEditor),
			onDidChange: this._onDidRepositoryChange.event
		};

		this._store.add(editorGroupsService.registerContextKeyProvider(hasChangesContextKeyProvider));
		this._store.add(editorGroupsService.registerContextKeyProvider(repositoryContextKeyProvider));
	}

	private _getEditorHasChanges(activeEditor: EditorInput | null): boolean {
		const activeResource = EditorResourceAccessor.getOriginalUri(activeEditor);
		if (!activeResource) {
			return false;
		}

		const activeResourceRepository = this.scmService.getRepository(activeResource);
		for (const resourceGroup of activeResourceRepository?.provider.groups ?? []) {
			if (resourceGroup.resources
				.some(scmResource =>
					this.uriIdentityService.extUri.isEqual(activeResource, scmResource.sourceUri))) {
				return true;
			}
		}

		return false;
	}

	private updateContextKey(): void {
		const activeResource = EditorResourceAccessor.getOriginalUri(this.editorService.activeEditor);

		if (activeResource?.scheme === Schemas.file || activeResource?.scheme === Schemas.vscodeRemote) {
			const activeResourceRepository = Iterable.find(
				this.scmService.repositories,
				r => Boolean(r.provider.rootUri && this.uriIdentityService.extUri.isEqualOrParent(activeResource, r.provider.rootUri))
			);

			this.activeResourceRepositoryContextKey.set(activeResourceRepository?.id);

			for (const resourceGroup of activeResourceRepository?.provider.groups ?? []) {
				if (resourceGroup.resources
					.some(scmResource =>
						this.uriIdentityService.extUri.isEqual(activeResource, scmResource.sourceUri))) {
					this.activeResourceHasChangesContextKey.set(true);
					return;
				}
			}

			this.activeResourceHasChangesContextKey.set(false);
		} else {
			this.activeResourceHasChangesContextKey.set(false);
			this.activeResourceRepositoryContextKey.set(undefined);
		}

		const activeResourceRepository = this.scmService.getRepository(activeResource);
		return activeResourceRepository?.id;
	}

	override dispose(): void {
		this._onDidRepositoryChange.dispose();
		super.dispose();
	}
}
