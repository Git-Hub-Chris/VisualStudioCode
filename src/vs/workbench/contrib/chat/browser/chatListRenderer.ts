/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { IActionViewItemOptions } from 'vs/base/browser/ui/actionbar/actionViewItems';
import { AriaRole } from 'vs/base/browser/ui/aria/aria';
import { Button } from 'vs/base/browser/ui/button/button';
import { renderIcon } from 'vs/base/browser/ui/iconLabel/iconLabels';
import { IListRenderer, IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { IListAccessibilityProvider } from 'vs/base/browser/ui/list/listWidget';
import { ITreeCompressionDelegate } from 'vs/base/browser/ui/tree/asyncDataTree';
import { ICompressedTreeNode } from 'vs/base/browser/ui/tree/compressedObjectTreeModel';
import { ICompressibleTreeRenderer } from 'vs/base/browser/ui/tree/objectTree';
import { IAsyncDataSource, ITreeNode, ITreeRenderer } from 'vs/base/browser/ui/tree/tree';
import { IAction } from 'vs/base/common/actions';
import { distinct } from 'vs/base/common/arrays';
import { IntervalTimer } from 'vs/base/common/async';
import { Codicon } from 'vs/base/common/codicons';
import { Emitter, Event } from 'vs/base/common/event';
import { FuzzyScore } from 'vs/base/common/filters';
import { IMarkdownString, MarkdownString } from 'vs/base/common/htmlContent';
import { Disposable, DisposableStore, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { ResourceMap } from 'vs/base/common/map';
import { marked } from 'vs/base/common/marked/marked';
import { FileAccess } from 'vs/base/common/network';
import { ThemeIcon } from 'vs/base/common/themables';
import { URI } from 'vs/base/common/uri';
import { IMarkdownRenderResult } from 'vs/editor/contrib/markdownRenderer/browser/markdownRenderer';
import { localize } from 'vs/nls';
import { IMenuEntryActionViewItemOptions, MenuEntryActionViewItem } from 'vs/platform/actions/browser/menuEntryActionViewItem';
import { MenuWorkbenchToolBar } from 'vs/platform/actions/browser/toolbar';
import { MenuId, MenuItemAction } from 'vs/platform/actions/common/actions';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { FileKind } from 'vs/platform/files/common/files';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { WorkbenchCompressibleAsyncDataTree, WorkbenchList } from 'vs/platform/list/browser/listService';
import { ILogService } from 'vs/platform/log/common/log';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IProductService } from 'vs/platform/product/common/productService';
import { defaultButtonStyles } from 'vs/platform/theme/browser/defaultStyles';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IResourceLabel, ResourceLabels } from 'vs/workbench/browser/labels';
import { AccessibilityVerbositySettingId } from 'vs/workbench/contrib/accessibility/browser/accessibilityConfiguration';
import { IAccessibleViewService } from 'vs/workbench/contrib/accessibility/browser/accessibleView';
import { ChatTreeItem, IChatCodeBlockInfo, IChatFileTreeInfo } from 'vs/workbench/contrib/chat/browser/chat';
import { ChatFollowups } from 'vs/workbench/contrib/chat/browser/chatFollowups';
import { convertParsedRequestToMarkdown, reduceInlineContentReferences, walkTreeAndAnnotateReferenceLinks } from 'vs/workbench/contrib/chat/browser/chatMarkdownDecorationsRenderer';
import { ChatMarkdownRenderer } from 'vs/workbench/contrib/chat/browser/chatMarkdownRenderer';
import { ChatEditorOptions } from 'vs/workbench/contrib/chat/browser/chatOptions';
import { ResourcePool } from 'vs/workbench/contrib/chat/browser/resourcePool';
import { CONTEXT_REQUEST, CONTEXT_RESPONSE, CONTEXT_RESPONSE_FILTERED, CONTEXT_RESPONSE_HAS_PROVIDER_ID, CONTEXT_RESPONSE_VOTE } from 'vs/workbench/contrib/chat/common/chatContextKeys';
import { IPlaceholderMarkdownString } from 'vs/workbench/contrib/chat/common/chatModel';
import { IChatContentReference, IChatReplyFollowup, IChatResponseProgressFileTreeData, IChatService, ISlashCommand, InteractiveSessionVoteDirection } from 'vs/workbench/contrib/chat/common/chatService';
import { IChatResponseMarkdownRenderData, IChatResponseRenderData, IChatResponseViewModel, IChatWelcomeMessageViewModel, isRequestVM, isResponseVM, isWelcomeVM } from 'vs/workbench/contrib/chat/common/chatViewModel';
import { IWordCountResult, getNWords } from 'vs/workbench/contrib/chat/common/chatWordCounter';
import { createFileIconThemableTreeContainerScope } from 'vs/workbench/contrib/files/browser/views/explorerView';
import { IFilesConfiguration } from 'vs/workbench/contrib/files/common/files';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';

const $ = dom.$;

interface IChatListItemTemplate {
	currentElement?: ChatTreeItem;
	renderedParts?: IChatContentPart[];
	readonly rowContainer: HTMLElement;
	readonly titleToolbar?: MenuWorkbenchToolBar;
	readonly footerToolbar: MenuWorkbenchToolBar;
	readonly avatarContainer: HTMLElement;
	readonly username: HTMLElement;
	readonly detail: HTMLElement;
	readonly value: HTMLElement;
	readonly contextKeyService: IContextKeyService;
	readonly instantiationService: IInstantiationService;
	readonly templateDisposables: IDisposable;
	readonly elementDisposables: DisposableStore;
	readonly agentHover: ChatAgentHover;
}

interface IItemHeightChangeParams {
	element: ChatTreeItem;
	height: number;
}

const forceVerboseLayoutTracing = false
	// || Boolean("TRUE") // causes a linter warning so that it cannot be pushed
	;

export interface IChatRendererDelegate {
	container: HTMLElement;
	getListLength(): number;

	readonly onDidScroll?: Event<void>;
}

const mostRecentResponseClassName = 'chat-most-recent-response';

export class ChatListItemRenderer extends Disposable implements ITreeRenderer<ChatTreeItem, FuzzyScore, IChatListItemTemplate> {
	static readonly ID = 'item';

	private readonly codeBlocksByResponseId = new Map<string, IChatCodeBlockInfo[]>();
	private readonly codeBlocksByEditorUri = new ResourceMap<IChatCodeBlockInfo>();

	private readonly fileTreesByResponseId = new Map<string, IChatFileTreeInfo[]>();
	private readonly focusedFileTreesByResponseId = new Map<string, number>();

	private readonly renderer: ChatMarkdownRenderer;

	protected readonly _onDidClickFollowup = this._register(new Emitter<IChatFollowup>());
	readonly onDidClickFollowup: Event<IChatFollowup> = this._onDidClickFollowup.event;

	private readonly _onDidClickRerunWithAgentOrCommandDetection = new Emitter<{ sessionId: string; requestId: string }>();
	readonly onDidClickRerunWithAgentOrCommandDetection: Event<{ sessionId: string; requestId: string }> = this._onDidClickRerunWithAgentOrCommandDetection.event;

	protected readonly _onDidChangeItemHeight = this._register(new Emitter<IItemHeightChangeParams>());
	readonly onDidChangeItemHeight: Event<IItemHeightChangeParams> = this._onDidChangeItemHeight.event;

	private readonly _treePool: TreePool;
	private readonly _contentReferencesListPool: CollapsibleListPool;

	private _currentLayoutWidth: number = 0;
	private _isVisible = true;
	private _onDidChangeVisibility = this._register(new Emitter<boolean>());

	/**
	 * Tool invocations get their own so that the ChatViewModel doesn't overwrite it.
	 * TODO@roblourens shouldn't use the CodeBlockModelCollection at all
	 */
	private readonly _toolInvocationCodeBlockCollection: CodeBlockModelCollection;

	constructor(
		editorOptions: ChatEditorOptions,
		private readonly rendererOptions: IChatListItemRendererOptions,
		private readonly delegate: IChatRendererDelegate,
		private readonly codeBlockModelCollection: CodeBlockModelCollection,
		overflowWidgetsDomNode: HTMLElement | undefined,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService configService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IThemeService private readonly themeService: IThemeService,
		@ICommandService private readonly commandService: ICommandService,
		@IHoverService private readonly hoverService: IHoverService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
	) {
		super();
		this.renderer = this.instantiationService.createInstance(ChatMarkdownRenderer, editorOptions);
		this._treePool = this._register(this.instantiationService.createInstance(TreePool, this._onDidChangeVisibility.event));
		this._contentReferencesListPool = this._register(this.instantiationService.createInstance(CollapsibleListPool, this._onDidChangeVisibility.event, undefined));

		this._register(this.instantiationService.createInstance(ChatCodeBlockContentProvider));
		this._toolInvocationCodeBlockCollection = this._register(this.instantiationService.createInstance(CodeBlockModelCollection, 'tools'));
	}

	get templateId(): string {
		return ChatListItemRenderer.ID;
	}

	editorsInUse(): Iterable<CodeBlockPart> {
		return Iterable.concat(this._editorPool.inUse(), this._toolEditorPool.inUse());
	}

	private traceLayout(method: string, message: string) {
		if (forceVerboseLayoutTracing) {
			this.logService.info(`ChatListItemRenderer#${method}: ${message}`);
		} else {
			this.logService.trace(`ChatListItemRenderer#${method}: ${message}`);
		}
	}

	/**
	 * Compute a rate to render at in words/s.
	 */
	private getProgressiveRenderRate(element: IChatResponseViewModel): number {
		const enum Rate {
			Min = 5,
			Max = 80,
		}

		if (element.isComplete || element.isPaused.get()) {
			return Rate.Max;
		}

		if (element.contentUpdateTimings && element.contentUpdateTimings.impliedWordLoadRate) {
			const rate = element.contentUpdateTimings.impliedWordLoadRate;
			return clamp(rate, Rate.Min, Rate.Max);
		}

		return 8;
	}

	getCodeBlockInfosForResponse(response: IChatResponseViewModel): IChatCodeBlockInfo[] {
		const codeBlocks = this.codeBlocksByResponseId.get(response.id);
		return codeBlocks ?? [];
	}

	getCodeBlockInfoForEditor(uri: URI): IChatCodeBlockInfo | undefined {
		return this.codeBlocksByEditorUri.get(uri);
	}

	getFileTreeInfosForResponse(response: IChatResponseViewModel): IChatFileTreeInfo[] {
		const fileTrees = this.fileTreesByResponseId.get(response.id);
		return fileTrees ?? [];
	}

	getLastFocusedFileTreeForResponse(response: IChatResponseViewModel): IChatFileTreeInfo | undefined {
		const fileTrees = this.fileTreesByResponseId.get(response.id);
		const lastFocusedFileTreeIndex = this.focusedFileTreesByResponseId.get(response.id);
		if (fileTrees?.length && lastFocusedFileTreeIndex !== undefined && lastFocusedFileTreeIndex < fileTrees.length) {
			return fileTrees[lastFocusedFileTreeIndex];
		}
		return undefined;
	}

	setVisible(visible: boolean): void {
		this._isVisible = visible;
		this._onDidChangeVisibility.fire(visible);
	}

	layout(width: number): void {
		this._currentLayoutWidth = width - 40; // TODO Padding
		this.renderer.layout(this._currentLayoutWidth);
	}

	renderTemplate(container: HTMLElement): IChatListItemTemplate {
		const templateDisposables = new DisposableStore();
		const rowContainer = dom.append(container, $('.interactive-item-container'));
		if (this.rendererOptions.renderStyle === 'compact') {
			rowContainer.classList.add('interactive-item-compact');
		}
		if (this.rendererOptions.noPadding) {
			rowContainer.classList.add('no-padding');
		}

		let headerParent = rowContainer;
		let valueParent = rowContainer;
		let detailContainerParent: HTMLElement | undefined;
		let toolbarParent: HTMLElement | undefined;

		if (this.rendererOptions.renderStyle === 'minimal') {
			rowContainer.classList.add('interactive-item-compact');
			rowContainer.classList.add('minimal');
			// -----------------------------------------------------
			//  icon | details
			//       | references
			//       | value
			// -----------------------------------------------------
			const lhsContainer = dom.append(rowContainer, $('.column.left'));
			const rhsContainer = dom.append(rowContainer, $('.column.right'));

			headerParent = lhsContainer;
			detailContainerParent = rhsContainer;
			valueParent = rhsContainer;
			toolbarParent = dom.append(rowContainer, $('.header'));
		}

		const header = dom.append(headerParent, $('.header'));
		const user = dom.append(header, $('.user'));
		const avatarContainer = dom.append(user, $('.avatar-container'));
		const username = dom.append(user, $('h3.username'));
		username.tabIndex = 0;
		const detailContainer = dom.append(detailContainerParent ?? user, $('span.detail-container'));
		const detail = dom.append(detailContainer, $('span.detail'));
		if (!this.rendererOptions.progressMessageAtBottomOfResponse) {
			dom.append(detailContainer, $('span.chat-animated-ellipsis'));
		}
		const value = dom.append(valueParent, $('.value'));
		const elementDisposables = new DisposableStore();

		const contextKeyService = templateDisposables.add(this.contextKeyService.createScoped(rowContainer));
		const scopedInstantiationService = templateDisposables.add(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, contextKeyService])));

		let titleToolbar: MenuWorkbenchToolBar | undefined;
		if (this.rendererOptions.noHeader) {
			header.classList.add('hidden');
		} else {
			titleToolbar = templateDisposables.add(scopedInstantiationService.createInstance(MenuWorkbenchToolBar, toolbarParent ?? header, MenuId.ChatMessageTitle, {
				menuOptions: {
					shouldForwardArgs: true
				},
				toolbarOptions: {
					shouldInlineSubmenu: submenu => submenu.actions.length <= 1
				},
			}));
		}

		const footerToolbarContainer = dom.append(rowContainer, $('.chat-footer-toolbar'));
		const footerToolbar = templateDisposables.add(scopedInstantiationService.createInstance(MenuWorkbenchToolBar, footerToolbarContainer, MenuId.ChatMessageFooter, {
			eventDebounceDelay: 0,
			menuOptions: { shouldForwardArgs: true, renderShortTitle: true },
			toolbarOptions: { shouldInlineSubmenu: submenu => submenu.actions.length <= 1 },
			actionViewItemProvider: (action: IAction, options: IActionViewItemOptions) => {
				if (action instanceof MenuItemAction && action.item.id === MarkUnhelpfulActionId) {
					return scopedInstantiationService.createInstance(ChatVoteDownButton, action, options as IMenuEntryActionViewItemOptions);
				}
				return createActionViewItem(scopedInstantiationService, action, options);
			}
		}));

		const agentHover = templateDisposables.add(this.instantiationService.createInstance(ChatAgentHover));
		const hoverContent = () => {
			if (isResponseVM(template.currentElement) && template.currentElement.agent && !template.currentElement.agent.isDefault) {
				agentHover.setAgent(template.currentElement.agent.id);
				return agentHover.domNode;
			}

			return undefined;
		};
		const hoverOptions = getChatAgentHoverOptions(() => isResponseVM(template.currentElement) ? template.currentElement.agent : undefined, this.commandService);
		templateDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), user, hoverContent, hoverOptions));
		templateDisposables.add(dom.addDisposableListener(user, dom.EventType.KEY_DOWN, e => {
			const ev = new StandardKeyboardEvent(e);
			if (ev.equals(KeyCode.Space) || ev.equals(KeyCode.Enter)) {
				const content = hoverContent();
				if (content) {
					this.hoverService.showInstantHover({ content, target: user, trapFocus: true, actions: hoverOptions.actions }, true);
				}
			} else if (ev.equals(KeyCode.Escape)) {
				this.hoverService.hideHover();
			}
		}));
		const template: IChatListItemTemplate = { avatarContainer, username, detail, value, rowContainer, elementDisposables, templateDisposables, contextKeyService, instantiationService: scopedInstantiationService, agentHover, titleToolbar, footerToolbar };
		return template;
	}

	renderElement(node: ITreeNode<ChatTreeItem, FuzzyScore>, index: number, templateData: IChatListItemTemplate): void {
		this.renderChatTreeItem(node.element, index, templateData);
	}

	private clearRenderedParts(templateData: IChatListItemTemplate): void {
		if (templateData.renderedParts) {
			dispose(coalesce(templateData.renderedParts));
			templateData.renderedParts = undefined;
			dom.clearNode(templateData.value);
		}
	}

	renderChatTreeItem(element: ChatTreeItem, index: number, templateData: IChatListItemTemplate): void {
		if (templateData.currentElement && templateData.currentElement.id !== element.id) {
			this.traceLayout('renderChatTreeItem', `Rendering a different element into the template, index=${index}`);
			this.clearRenderedParts(templateData);
		}

		templateData.currentElement = element;
		const kind = isRequestVM(element) ? 'request' :
			isResponseVM(element) ? 'response' :
				'welcome';
		this.traceLayout('renderElement', `${kind}, index=${index}`);

		ChatContextKeys.isResponse.bindTo(templateData.contextKeyService).set(isResponseVM(element));
		ChatContextKeys.itemId.bindTo(templateData.contextKeyService).set(element.id);
		ChatContextKeys.isRequest.bindTo(templateData.contextKeyService).set(isRequestVM(element));
		ChatContextKeys.responseDetectedAgentCommand.bindTo(templateData.contextKeyService).set(isResponseVM(element) && element.agentOrSlashCommandDetected);
		if (isResponseVM(element)) {
			ChatContextKeys.responseSupportsIssueReporting.bindTo(templateData.contextKeyService).set(!!element.agent?.metadata.supportIssueReporting);
			ChatContextKeys.responseVote.bindTo(templateData.contextKeyService).set(element.vote === ChatAgentVoteDirection.Up ? 'up' : element.vote === ChatAgentVoteDirection.Down ? 'down' : '');
		} else {
			ChatContextKeys.responseVote.bindTo(templateData.contextKeyService).set('');
		}

		if (templateData.titleToolbar) {
			templateData.titleToolbar.context = element;
		}
		templateData.footerToolbar.context = element;

		ChatContextKeys.responseHasError.bindTo(templateData.contextKeyService).set(isResponseVM(element) && !!element.errorDetails);
		const isFiltered = !!(isResponseVM(element) && element.errorDetails?.responseIsFiltered);
		ChatContextKeys.responseIsFiltered.bindTo(templateData.contextKeyService).set(isFiltered);

		templateData.rowContainer.classList.toggle('editing-session', this.chatWidgetService.getWidgetBySessionId(element.sessionId)?.location === ChatAgentLocation.EditingSession);
		templateData.rowContainer.classList.toggle('interactive-request', isRequestVM(element));
		templateData.rowContainer.classList.toggle('interactive-response', isResponseVM(element));
		templateData.rowContainer.classList.toggle('show-detail-progress', isResponseVM(element) && !element.isComplete && !element.progressMessages.length && !element.model.isPaused.get());
		templateData.username.textContent = element.username;
		if (!this.rendererOptions.noHeader) {
			this.renderAvatar(element, templateData);
		}

		dom.clearNode(templateData.detail);
		if (isResponseVM(element)) {
			this.renderDetail(element, templateData);
		}

		templateData.rowContainer.classList.toggle(mostRecentResponseClassName, index === this.delegate.getListLength() - 1);

		if (isRequestVM(element) && element.confirmation) {
			this.renderConfirmationAction(element, templateData);
		}

		// Do a progressive render if
		// - This the last response in the list
		// - And it has some content
		// - And the response is not complete
		//   - Or, we previously started a progressive rendering of this element (if the element is complete, we will finish progressive rendering with a very fast rate)
		if (isResponseVM(element) && index === this.delegate.getListLength() - 1 && (!element.isComplete || element.renderData)) {
			this.traceLayout('renderElement', `start progressive render, index=${index}`);

			const timer = templateData.elementDisposables.add(new dom.WindowIntervalTimer());
			const runProgressiveRender = (initial?: boolean) => {
				try {
					if (this.doNextProgressiveRender(element, index, templateData, !!initial)) {
						timer.cancel();
					}
				} catch (err) {
					// Kill the timer if anything went wrong, avoid getting stuck in a nasty rendering loop.
					timer.cancel();
					this.logService.error(err);
				}
			};
			timer.cancelAndSet(runProgressiveRender, 50, dom.getWindow(templateData.rowContainer));
			runProgressiveRender(true);
		} else {
			if (isResponseVM(element)) {
				this.basicRenderElement(element, index, templateData);
			} else if (isRequestVM(element)) {
				this.basicRenderElement(element, index, templateData);
			}
		}
	}

	private renderDetail(element: IChatResponseViewModel, templateData: IChatListItemTemplate): void {
		templateData.elementDisposables.add(autorun(reader => {
			this._renderDetail(element, templateData);
		}));
	}

	private _renderDetail(element: IChatResponseViewModel, templateData: IChatListItemTemplate): void {

		dom.clearNode(templateData.detail);

		if (element.agentOrSlashCommandDetected) {
			const msg = element.slashCommand ? localize('usedAgentSlashCommand', "used {0} [[(rerun without)]]", `${chatSubcommandLeader}${element.slashCommand.name}`) : localize('usedAgent', "[[(rerun without)]]");
			dom.reset(templateData.detail, renderFormattedText(msg, {
				className: 'agentOrSlashCommandDetected',
				inline: true,
				actionHandler: {
					disposables: templateData.elementDisposables,
					callback: (content) => {
						this._onDidClickRerunWithAgentOrCommandDetection.fire(element);
					},
				}
			}));

		} else if (this.rendererOptions.renderStyle !== 'minimal' && !element.isComplete && !this.rendererOptions.progressMessageAtBottomOfResponse) {
			if (element.model.isPaused.get()) {
				templateData.detail.textContent = localize('paused', "Paused");
			} else {
				templateData.detail.textContent = localize('working', "Working");
			}
		}
	}

	private renderConfirmationAction(element: IChatRequestViewModel, templateData: IChatListItemTemplate) {
		dom.clearNode(templateData.detail);
		if (element.confirmation) {
			templateData.detail.textContent = localize('chatConfirmationAction', 'selected "{0}"', element.confirmation);
		}
	}

	private renderAvatar(element: ChatTreeItem, templateData: IChatListItemTemplate): void {
		const icon = isResponseVM(element) ?
			this.getAgentIcon(element.agent?.metadata) :
			(element.avatarIcon ?? Codicon.account);
		if (icon instanceof URI) {
			const avatarIcon = dom.$<HTMLImageElement>('img.icon');
			avatarIcon.src = FileAccess.uriToBrowserUri(icon).toString(true);
			templateData.avatarContainer.replaceChildren(dom.$('.avatar', undefined, avatarIcon));
		} else {
			const avatarIcon = dom.$(ThemeIcon.asCSSSelector(icon));
			templateData.avatarContainer.replaceChildren(dom.$('.avatar.codicon-avatar', undefined, avatarIcon));
		}
	}

	private getAgentIcon(agent: IChatAgentMetadata | undefined): URI | ThemeIcon {
		if (agent?.themeIcon) {
			return agent.themeIcon;
		} else if (agent?.iconDark && this.themeService.getColorTheme().type === ColorScheme.DARK) {
			return agent.iconDark;
		} else if (agent?.icon) {
			return agent.icon;
		} else {
			return Codicon.copilot;
		}
	}

	private basicRenderElement(element: ChatTreeItem, index: number, templateData: IChatListItemTemplate) {
		templateData.rowContainer.classList.toggle('chat-response-loading', (isResponseVM(element) && !element.isComplete));

		let value: IChatRendererContent[] = [];
		if (isRequestVM(element) && !element.confirmation) {
			const markdown = 'message' in element.message ?
				element.message.message :
				this.markdownDecorationsRenderer.convertParsedRequestToMarkdown(element.message);
			value = [{ content: new MarkdownString(markdown), kind: 'markdownContent' }];

			if (this.rendererOptions.renderStyle === 'minimal' && !element.isComplete) {
				templateData.value.classList.add('inline-progress');
				value.push({ content: new MarkdownString('<span></span>', { supportHtml: true }), kind: 'markdownContent' });
			} else {
				templateData.value.classList.remove('inline-progress');
			}

		} else if (isResponseVM(element)) {
			if (element.contentReferences.length) {
				value.push({ kind: 'references', references: element.contentReferences });
			}
			value.push(...annotateSpecialMarkdownContent(element.response.value));
			if (element.codeCitations.length) {
				value.push({ kind: 'codeCitations', citations: element.codeCitations });
			}
		}

		dom.clearNode(templateData.value);

		if (isResponseVM(element)) {
			this.renderDetail(element, templateData);
		}

		const isFiltered = !!(isResponseVM(element) && element.errorDetails?.responseIsFiltered);

		const parts: IChatContentPart[] = [];
		if (!isFiltered) {

			let inlineSlashCommandRendered = false;

			value.forEach((data, index) => {
				const context: IChatContentPartRenderContext = {
					element,
					contentIndex: index,
					content: value,
					preceedingContentParts: parts,
				};
				const newPart = this.renderChatContentPart(data, templateData, context);
				if (newPart) {

					if (this.rendererOptions.renderDetectedCommandsWithRequest
						&& !inlineSlashCommandRendered
						&& isRequestVM(element) && element.agentOrSlashCommandDetected && element.slashCommand
						&& data.kind === 'markdownContent' // TODO this is fishy but I didn't find a better way to render on the same inline as the MD request part
					) {
						if (newPart.domNode) {
							newPart.domNode.style.display = 'inline-flex';
						}
						const cmdPart = this.instantiationService.createInstance(ChatAgentCommandContentPart, element.slashCommand, () => this._onDidClickRerunWithAgentOrCommandDetection.fire({ sessionId: element.sessionId, requestId: element.id }));
						templateData.value.appendChild(cmdPart.domNode);
						parts.push(cmdPart);
						inlineSlashCommandRendered = true;
					}

					if (newPart.domNode) {
						templateData.value.appendChild(newPart.domNode);
					}
					parts.push(newPart);
				}
			});
		}

		if (templateData.renderedParts) {
			dispose(templateData.renderedParts);
		}
		templateData.renderedParts = parts;

		if (!isFiltered) {
			if (isRequestVM(element) && element.variables.length) {
				const newPart = this.renderAttachments(element.variables, element.contentReferences, templateData);
				if (newPart) {
					if (newPart.domNode) {
						// p has a :last-child rule for margin
						templateData.value.appendChild(newPart.domNode);
					}
					templateData.elementDisposables.add(newPart);
				}
			}
		}

		if (isResponseVM(element) && element.errorDetails?.message) {
			if (element.errorDetails.isQuotaExceeded) {
				const renderedError = this.instantiationService.createInstance(ChatQuotaExceededPart, element, this.renderer);
				templateData.elementDisposables.add(renderedError);
				templateData.value.appendChild(renderedError.domNode);
				templateData.elementDisposables.add(renderedError.onDidChangeHeight(() => this.updateItemHeight(templateData)));
			} else {
				const level = element.errorDetails.level ?? (element.errorDetails.responseIsFiltered ? ChatErrorLevel.Info : ChatErrorLevel.Error);
				const renderedError = this.instantiationService.createInstance(ChatWarningContentPart, level, new MarkdownString(element.errorDetails.message), this.renderer);
				templateData.elementDisposables.add(renderedError);
				templateData.value.appendChild(renderedError.domNode);
			}
		}

		const newHeight = templateData.rowContainer.offsetHeight;
		const fireEvent = !element.currentRenderedHeight || element.currentRenderedHeight !== newHeight;
		element.currentRenderedHeight = newHeight;
		if (fireEvent) {
			const disposable = templateData.elementDisposables.add(dom.scheduleAtNextAnimationFrame(dom.getWindow(templateData.value), () => {
				// Have to recompute the height here because codeblock rendering is currently async and it may have changed.
				// If it becomes properly sync, then this could be removed.
				element.currentRenderedHeight = templateData.rowContainer.offsetHeight;
				disposable.dispose();
				this._onDidChangeItemHeight.fire({ element, height: element.currentRenderedHeight });
			}));
		}
	}

	private updateItemHeight(templateData: IChatListItemTemplate): void {
		if (!templateData.currentElement) {
			return;
		}

		const newHeight = Math.max(templateData.rowContainer.offsetHeight, 1);
		templateData.currentElement.currentRenderedHeight = newHeight;
		this._onDidChangeItemHeight.fire({ element: templateData.currentElement, height: newHeight });
	}

	/**
	 *	@returns true if progressive rendering should be considered complete- the element's data is fully rendered or the view is not visible
	 */
	private doNextProgressiveRender(element: IChatResponseViewModel, index: number, templateData: IChatListItemTemplate, isInRenderElement: boolean): boolean {
		if (!this._isVisible) {
			return true;
		}

		if (element.isCanceled) {
			this.traceLayout('doNextProgressiveRender', `canceled, index=${index}`);
			element.renderData = undefined;
			this.basicRenderElement(element, index, templateData);
			return true;
		}

		templateData.rowContainer.classList.toggle('chat-response-loading', true);
		this.traceLayout('doNextProgressiveRender', `START progressive render, index=${index}, renderData=${JSON.stringify(element.renderData)}`);
		const contentForThisTurn = this.getNextProgressiveRenderContent(element);
		const partsToRender = this.diff(templateData.renderedParts ?? [], contentForThisTurn.content, element);

		const contentIsAlreadyRendered = partsToRender.every(part => part === null);
		if (contentIsAlreadyRendered) {
			if (contentForThisTurn.moreContentAvailable) {
				// The content that we want to render in this turn is already rendered, but there is more content to render on the next tick
				this.traceLayout('doNextProgressiveRender', 'not rendering any new content this tick, but more available');
				return false;
			} else if (element.isComplete) {
				// All content is rendered, and response is done, so do a normal render
				this.traceLayout('doNextProgressiveRender', `END progressive render, index=${index} and clearing renderData, response is complete`);
				element.renderData = undefined;
				this.basicRenderElement(element, index, templateData);
				return true;
			} else {
				// Nothing new to render, stop rendering until next model update
				this.traceLayout('doNextProgressiveRender', 'caught up with the stream- no new content to render');

				if (!templateData.renderedParts) {
					// First render? Initialize currentRenderedHeight. https://github.com/microsoft/vscode/issues/232096
					const height = templateData.rowContainer.offsetHeight;
					element.currentRenderedHeight = height;
				}

				return true;
			}
		}

		// Do an actual progressive render
		this.traceLayout('doNextProgressiveRender', `doing progressive render, ${partsToRender.length} parts to render`);
		this.renderChatContentDiff(partsToRender, contentForThisTurn.content, element, templateData);

		const height = templateData.rowContainer.offsetHeight;
		element.currentRenderedHeight = height;
		if (!isInRenderElement) {
			this._onDidChangeItemHeight.fire({ element, height });
		}

		return false;
	}

	private renderChatContentDiff(partsToRender: ReadonlyArray<IChatRendererContent | null>, contentForThisTurn: ReadonlyArray<IChatRendererContent>, element: IChatResponseViewModel, templateData: IChatListItemTemplate): void {
		const renderedParts = templateData.renderedParts ?? [];
		templateData.renderedParts = renderedParts;
		partsToRender.forEach((partToRender, index) => {
			if (!partToRender) {
				// null=no change
				return;
			}

			const alreadyRenderedPart = templateData.renderedParts?.[index];
			if (alreadyRenderedPart) {
				alreadyRenderedPart.dispose();
			}

			const preceedingContentParts = renderedParts.slice(0, index);
			const context: IChatContentPartRenderContext = {
				element,
				content: contentForThisTurn,
				preceedingContentParts,
				contentIndex: index,
			};
			const newPart = this.renderChatContentPart(partToRender, templateData, context);
			if (newPart) {
				renderedParts[index] = newPart;
				// Maybe the part can't be rendered in this context, but this shouldn't really happen
				try {
					if (alreadyRenderedPart?.domNode) {
						if (newPart.domNode) {
							// This method can throw HierarchyRequestError
							alreadyRenderedPart.domNode.replaceWith(newPart.domNode);
						} else {
							alreadyRenderedPart.domNode.remove();
						}
					} else if (newPart.domNode) {
						templateData.value.appendChild(newPart.domNode);
					}
				} catch (err) {
					this.logService.error('ChatListItemRenderer#renderChatContentDiff: error replacing part', err);
				}
			} else {
				alreadyRenderedPart?.domNode?.remove();
			}
		});
	}

	private renderPlaceholder(markdown: IMarkdownString, templateData: IChatListItemTemplate): IMarkdownRenderResult {
		const codicon = $('.interactive-response-codicon-details', undefined, renderIcon({ id: 'sync~spin' }));
		codicon.classList.add('interactive-response-placeholder-codicon');
		const result = dom.append(templateData.value, codicon);

		const content = this.renderer.renderSimple(markdown);
		content.element.className = 'interactive-response-placeholder-content';
		result.appendChild(content.element);

		return { element: result, dispose: () => content.dispose() };
	}

	private renderMarkdown(markdown: IMarkdownString, element: ChatTreeItem, templateData: IChatListItemTemplate, fillInIncompleteTokens = false): IMarkdownRenderResult {
		const disposables = new DisposableStore();

		// TODO if the slash commands stay completely dynamic, this isn't quite right
		const slashCommands = this.delegate.getSlashCommands();
		const usedSlashCommand = slashCommands.find(s => markdown.value.startsWith(`/${s.command} `));
		const toRender = usedSlashCommand ? markdown.value.slice(usedSlashCommand.command.length + 2) : markdown.value;
		markdown = new MarkdownString(toRender, {
			isTrusted: {
				// Disable all other config options except isTrusted
				enabledCommands: typeof markdown.isTrusted === 'object' ? markdown.isTrusted?.enabledCommands : [] ?? []
			}
		});

		const result = this.renderer.render(markdown, element, templateData.contextKeyService, fillInIncompleteTokens);

		if (isResponseVM(element)) {
			this.codeBlocksByResponseId.set(element.id, result.codeblocks);
			disposables.add(toDisposable(() => this.codeBlocksByResponseId.delete(element.id)));
		}

		const lastWordCount = element.contentUpdateTimings?.lastWordCount ?? 0;
		const newRenderedWordCount = data.numWordsToRender - numNeededWords;
		const bufferWords = lastWordCount - newRenderedWordCount;
		this.traceLayout('getNextProgressiveRenderContent', `Want to render ${data.numWordsToRender} words. Rendering ${newRenderedWordCount} words. Buffer: ${bufferWords} words`);
		if (newRenderedWordCount > 0 && newRenderedWordCount !== element.renderData?.renderedWordCount) {
			// Only update lastRenderTime when we actually render new content
			element.renderData = { lastRenderTime: Date.now(), renderedWordCount: newRenderedWordCount, renderedParts: partsToRender };
		}

		if (this.shouldShowWorkingProgress(element, partsToRender)) {
			const isPaused = element.model.isPaused.get();
			partsToRender.push({ kind: 'working', isPaused });
		}

		return {
			element: result.element,
			dispose() {
				result.dispose();
				disposables.dispose();
			}
		};
	}

	private getDataForProgressiveRender(element: IChatResponseViewModel, data: IMarkdownString, renderData: Pick<IChatResponseMarkdownRenderData, 'lastRenderTime' | 'renderedWordCount'>): IWordCountResult | undefined {
		const rate = this.getProgressiveRenderRate(element);
		const numWordsToRender = renderData.lastRenderTime === 0 ?
			1 :
			renderData.renderedWordCount +
			// Additional words to render beyond what's already rendered
			Math.floor((Date.now() - renderData.lastRenderTime) / 1000 * rate);

		return {
			numWordsToRender,
			rate
		};
	}

	private diff(renderedParts: ReadonlyArray<IChatContentPart>, contentToRender: ReadonlyArray<IChatRendererContent>, element: ChatTreeItem): ReadonlyArray<IChatRendererContent | null> {
		const diff: (IChatRendererContent | null)[] = [];
		for (let i = 0; i < contentToRender.length; i++) {
			const content = contentToRender[i];
			const renderedPart = renderedParts[i];

			if (!renderedPart || !renderedPart.hasSameContent(content, contentToRender.slice(i + 1), element)) {
				diff.push(content);
			} else {
				// null -> no change
				diff.push(null);
			}
		}

		return diff;
	}

	private renderChatContentPart(content: IChatRendererContent, templateData: IChatListItemTemplate, context: IChatContentPartRenderContext): IChatContentPart | undefined {
		if (content.kind === 'treeData') {
			return this.renderTreeData(content, templateData, context);
		} else if (content.kind === 'progressMessage') {
			return this.instantiationService.createInstance(ChatProgressContentPart, content, this.renderer, context, undefined, undefined, undefined);
		} else if (content.kind === 'progressTask') {
			return this.renderProgressTask(content, templateData, context);
		} else if (content.kind === 'command') {
			return this.instantiationService.createInstance(ChatCommandButtonContentPart, content, context);
		} else if (content.kind === 'textEditGroup') {
			return this.renderTextEdit(context, content, templateData);
		} else if (content.kind === 'confirmation') {
			return this.renderConfirmation(context, content, templateData);
		} else if (content.kind === 'warning') {
			return this.instantiationService.createInstance(ChatWarningContentPart, ChatErrorLevel.Warning, content.content, this.renderer);
		} else if (content.kind === 'markdownContent') {
			return this.renderMarkdown(content, templateData, context);
		} else if (content.kind === 'references') {
			return this.renderContentReferencesListData(content, undefined, context, templateData);
		} else if (content.kind === 'codeCitations') {
			return this.renderCodeCitations(content, context, templateData);
		} else if (content.kind === 'toolInvocation' || content.kind === 'toolInvocationSerialized') {
			return this.renderToolInvocation(content, context, templateData);
		} else if (content.kind === 'working') {
			return this.renderWorkingProgress(content, context);
		} else if (content.kind === 'undoStop') {
			return this.renderUndoStop(content);
		}

		return this.renderNoContent(other => content.kind === other.kind);
	}

	private renderUndoStop(content: IChatUndoStop) {
		return this.renderNoContent(other => other.kind === content.kind && other.id === content.id);
	}

	private renderNoContent(equals: (otherContent: IChatRendererContent) => boolean): IChatContentPart {
		return {
			dispose: () => { },
			domNode: undefined,
			hasSameContent: equals,
		};
	}

	private renderTreeData(content: IChatTreeData, templateData: IChatListItemTemplate, context: IChatContentPartRenderContext): IChatContentPart {
		const data = content.treeData;
		const treeDataIndex = context.preceedingContentParts.filter(part => part instanceof ChatTreeContentPart).length;
		const treePart = this.instantiationService.createInstance(ChatTreeContentPart, data, context.element, this._treePool, treeDataIndex);

		treePart.addDisposable(treePart.onDidChangeHeight(() => {
			this.updateItemHeight(templateData);
		}));

		if (isResponseVM(context.element)) {
			const fileTreeFocusInfo = {
				treeDataId: data.uri.toString(),
				treeIndex: treeDataIndex,
				focus() {
					treePart.domFocus();
				}
			};

			// TODO@roblourens there's got to be a better way to navigate trees
			treePart.addDisposable(treePart.onDidFocus(() => {
				this.focusedFileTreesByResponseId.set(context.element.id, fileTreeFocusInfo.treeIndex);
			}));

			const fileTrees = this.fileTreesByResponseId.get(context.element.id) ?? [];
			fileTrees.push(fileTreeFocusInfo);
			this.fileTreesByResponseId.set(context.element.id, distinct(fileTrees, (v) => v.treeDataId));
			treePart.addDisposable(toDisposable(() => this.fileTreesByResponseId.set(context.element.id, fileTrees.filter(v => v.treeDataId !== data.uri.toString()))));
		}

		return treePart;
	}

	private _getLabelWithCodeBlockCount(element: IChatResponseViewModel): string {
		const accessibleViewHint = this._accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.Chat);
		let label: string = '';
		let commandFollowUpInfo;
		const commandFollowupLength = element.commandFollowups?.length ?? 0;
		switch (commandFollowupLength) {
			case 0:
				break;
			case 1:
				commandFollowUpInfo = localize('commandFollowUpInfo', "Command: {0}", element.commandFollowups![0].title);
				break;
			default:
				commandFollowUpInfo = localize('commandFollowUpInfoMany', "Commands: {0}", element.commandFollowups!.map(followup => followup.title).join(', '));
		}
		const fileTreeCount = element.response.value.filter((v) => !('value' in v))?.length ?? 0;
		let fileTreeCountHint = '';
		switch (fileTreeCount) {
			case 0:
				break;
			case 1:
				fileTreeCountHint = localize('singleFileTreeHint', "1 file tree");
				break;
			default:
				fileTreeCountHint = localize('multiFileTreeHint', "{0} file trees", fileTreeCount);
				break;
		}
		const codeBlockCount = marked.lexer(element.response.asString()).filter(token => token.type === 'code')?.length ?? 0;
		switch (codeBlockCount) {
			case 0:
				label = accessibleViewHint ? localize('noCodeBlocksHint', "{0} {1} {2}", fileTreeCountHint, element.response.asString(), accessibleViewHint) : localize('noCodeBlocks', "{0} {1}", fileTreeCountHint, element.response.asString());
				break;
			case 1:
				label = accessibleViewHint ? localize('singleCodeBlockHint', "{0} 1 code block: {1} {2}", fileTreeCountHint, element.response.asString(), accessibleViewHint) : localize('singleCodeBlock', "{0} 1 code block: {1}", fileTreeCountHint, element.response.asString());
				break;
			default:
				label = accessibleViewHint ? localize('multiCodeBlockHint', "{0} {1} code blocks: {2}", fileTreeCountHint, codeBlockCount, element.response.asString(), accessibleViewHint) : localize('multiCodeBlock', "{0} {1} code blocks", fileTreeCountHint, codeBlockCount, element.response.asString());
				break;
		}
		return commandFollowUpInfo ? commandFollowUpInfo + ', ' + label : label;
	}
}

interface IDisposableReference<T> extends IDisposable {
	object: T;
	isStale: () => boolean;
}
class TreePool extends Disposable {
	private _pool: ResourcePool<WorkbenchCompressibleAsyncDataTree<IChatResponseProgressFileTreeData, IChatResponseProgressFileTreeData, void>>;

	private renderConfirmation(context: IChatContentPartRenderContext, confirmation: IChatConfirmation, templateData: IChatListItemTemplate): IChatContentPart {
		const part = this.instantiationService.createInstance(ChatConfirmationContentPart, confirmation, context);
		part.addDisposable(part.onDidChangeHeight(() => this.updateItemHeight(templateData)));
		return part;
	}

	private renderAttachments(variables: IChatRequestVariableEntry[], contentReferences: ReadonlyArray<IChatContentReference> | undefined, templateData: IChatListItemTemplate) {
		return this.instantiationService.createInstance(ChatAttachmentsContentPart, variables, contentReferences, undefined);
	}

	private renderTextEdit(context: IChatContentPartRenderContext, chatTextEdit: IChatTextEditGroup, templateData: IChatListItemTemplate): IChatContentPart {
		const textEditPart = this.instantiationService.createInstance(ChatTextEditContentPart, chatTextEdit, context, this.rendererOptions, this._diffEditorPool, this._currentLayoutWidth);
		textEditPart.addDisposable(textEditPart.onDidChangeHeight(() => {
			textEditPart.layout(this._currentLayoutWidth);
			this.updateItemHeight(templateData);
		}));

		return textEditPart;
	}

	private renderMarkdown(markdown: IChatMarkdownContent, templateData: IChatListItemTemplate, context: IChatContentPartRenderContext): IChatContentPart {
		const element = context.element;
		const fillInIncompleteTokens = isResponseVM(element) && (!element.isComplete || element.isCanceled || element.errorDetails?.responseIsFiltered || element.errorDetails?.responseIsIncomplete || !!element.renderData);
		const codeBlockStartIndex = this.getCodeBlockStartIndex(context);
		const options: IChatMarkdownContentPartOptions = {
			renderCodeBlockPills: this.rendererOptions.renderCodeBlockPills,
		};
		const markdownPart = templateData.instantiationService.createInstance(ChatMarkdownContentPart, markdown, context, this._editorPool, fillInIncompleteTokens, codeBlockStartIndex, this.renderer, this._currentLayoutWidth, this.codeBlockModelCollection, options);
		markdownPart.addDisposable(markdownPart.onDidChangeHeight(() => {
			markdownPart.layout(this._currentLayoutWidth);
			this.updateItemHeight(templateData);
		}));

		this.handleRenderedCodeblocks(element, markdownPart, codeBlockStartIndex);

		return markdownPart;
	}

	disposeElement(node: ITreeNode<ChatTreeItem, FuzzyScore>, index: number, templateData: IChatListItemTemplate): void {
		this.traceLayout('disposeElement', `Disposing element, index=${index}`);
		templateData.elementDisposables.clear();

		// Don't retain the toolbar context which includes chat viewmodels
		if (templateData.titleToolbar) {
			templateData.titleToolbar.context = undefined;
		}
		templateData.footerToolbar.context = undefined;
	}

	disposeTemplate(templateData: IChatListItemTemplate): void {
		templateData.templateDisposables.dispose();
	}
}

export class ChatListDelegate implements IListVirtualDelegate<ChatTreeItem> {
	constructor(
		private readonly defaultElementHeight: number,
		@ILogService private readonly logService: ILogService
	) { }

	private _traceLayout(method: string, message: string) {
		if (forceVerboseLayoutTracing) {
			this.logService.info(`ChatListDelegate#${method}: ${message}`);
		} else {
			this.logService.trace(`ChatListDelegate#${method}: ${message}`);
		}
	}

	getHeight(element: ChatTreeItem): number {
		const kind = isRequestVM(element) ? 'request' : 'response';
		const height = ('currentRenderedHeight' in element ? element.currentRenderedHeight : undefined) ?? this.defaultElementHeight;
		this._traceLayout('getHeight', `${kind}, height=${height}`);
		return height;
	}

	getTemplateId(element: ChatTreeItem): string {
		return ChatListItemRenderer.ID;
	}

	hasDynamicHeight(element: ChatTreeItem): boolean {
		return true;
	}
}


class ChatVoteButton extends MenuEntryActionViewItem {
	override render(container: HTMLElement): void {
		super.render(container);

		this.element?.classList.toggle('checked', this.action.checked);
	}

	private getVoteDownDetailAction(reason: ChatAgentVoteDownReason): IAction {
		const label = voteDownDetailLabels[reason];
		return {
			id: MarkUnhelpfulActionId,
			label,
			tooltip: '',
			enabled: true,
			checked: (this._context as IChatResponseViewModel).voteDownReason === reason,
			class: undefined,
			run: async (context: IChatResponseViewModel) => {
				if (!isResponseVM(context)) {
					this.logService.error('ChatVoteDownButton#getVoteDownDetailAction: invalid context');
					return;
				}

				await this.commandService.executeCommand(MarkUnhelpfulActionId, context, reason);
			}
		};
	}
}
