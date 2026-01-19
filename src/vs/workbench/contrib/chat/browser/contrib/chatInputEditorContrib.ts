/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellation } from 'vs/base/common/async';
import { CancellationToken } from 'vs/base/common/cancellation';
import { Disposable, MutableDisposable } from 'vs/base/common/lifecycle';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { IWordAtPosition, getWordAtText } from 'vs/editor/common/core/wordHelper';
import { IDecorationOptions, IEditorDecorationsCollection } from 'vs/editor/common/editorCommon';
import { CompletionContext, CompletionItem, CompletionItemKind, CompletionList } from 'vs/editor/common/languages';
import { IModelDeltaDecoration, ITextModel } from 'vs/editor/common/model';
import { ILanguageFeaturesService } from 'vs/editor/common/services/languageFeatures';
import { localize } from 'vs/nls';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IProductService } from 'vs/platform/product/common/productService';
import { Registry } from 'vs/platform/registry/common/platform';
import { inputPlaceholderForeground } from 'vs/platform/theme/common/colorRegistry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from 'vs/workbench/common/contributions';
import { SubmitAction } from 'vs/workbench/contrib/chat/browser/actions/chatExecuteActions';
import { IChatWidget, IChatWidgetService } from 'vs/workbench/contrib/chat/browser/chat';
import { ChatInputPart } from 'vs/workbench/contrib/chat/browser/chatInputPart';
import { ChatWidget } from 'vs/workbench/contrib/chat/browser/chatWidget';
import { SelectAndInsertFileAction, dynamicVariableDecorationType } from 'vs/workbench/contrib/chat/browser/contrib/chatDynamicVariables';
import { IChatAgentCommand, IChatAgentData, IChatAgentService } from 'vs/workbench/contrib/chat/common/chatAgents';
import { chatSlashCommandBackground, chatSlashCommandForeground } from 'vs/workbench/contrib/chat/common/chatColors';
import { ChatRequestAgentPart, ChatRequestAgentSubcommandPart, ChatRequestSlashCommandPart, ChatRequestTextPart, ChatRequestVariablePart, IParsedChatRequestPart, chatAgentLeader, chatSubcommandLeader, chatVariableLeader } from 'vs/workbench/contrib/chat/common/chatParserTypes';
import { ChatRequestParser } from 'vs/workbench/contrib/chat/common/chatRequestParser';
import { IChatService } from 'vs/workbench/contrib/chat/common/chatService';
import { IChatSlashCommandService } from 'vs/workbench/contrib/chat/common/chatSlashCommands';
import { IChatVariablesService } from 'vs/workbench/contrib/chat/common/chatVariables';
import { isResponseVM } from 'vs/workbench/contrib/chat/common/chatViewModel';
import { LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';

const decorationDescription = 'chat';
const placeholderDecorationType = 'chat-session-detail';
const slashCommandTextDecorationType = 'chat-session-text';
const variableTextDecorationType = 'chat-variable-text';

function agentAndCommandToKey(agent: IChatAgentData, subcommand: string | undefined): string {
	return subcommand ? `${agent.id}__${subcommand}` : agent.id;
}

class InputEditorDecorations extends Disposable {

	public readonly id = 'inputEditorDecorations';

	private readonly previouslyUsedAgents = new Set<string>();

	private readonly viewModelDisposables = this._register(new MutableDisposable());

	private readonly placeholderDecorations: IEditorDecorationsCollection;

	constructor(
		private readonly widget: IChatWidget,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IThemeService private readonly themeService: IThemeService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
	) {
		super();

		this.codeEditorService.registerDecorationType(decorationDescription, placeholderDecorationType, {});
		this.placeholderDecorations = this.widget.inputEditor.createDecorationsCollection();

		this._register(this.themeService.onDidColorThemeChange(() => this.updateRegisteredDecorationTypes()));
		this.updateRegisteredDecorationTypes();

		this.updateInputEditorDecorations();
		this._register(this.widget.inputEditor.onDidChangeModelContent(() => this.updateInputEditorDecorations()));
		this._register(this.widget.onDidChangeParsedInput(() => this.updateInputEditorDecorations()));
		this._register(this.widget.onDidChangeViewModel(() => {
			this.registerViewModelListeners();
			this.previouslyUsedAgents.clear();
			this.updateInputEditorDecorations();
		}));
		this._register(this.widget.onDidSubmitAgent((e) => {
			this.previouslyUsedAgents.add(agentAndCommandToKey(e.agent, e.slashCommand?.name));
		}));
		this._register(this.chatAgentService.onDidChangeAgents(() => this.updateInputEditorDecorations()));

		this.registerViewModelListeners();
	}

	private registerViewModelListeners(): void {
		this.viewModelDisposables.value = this.widget.viewModel?.onDidChange(e => {
			if (e?.kind === 'changePlaceholder' || e?.kind === 'initialize') {
				this.updateInputEditorDecorations();
			}
		});
	}

	private updateRegisteredDecorationTypes() {
		this.codeEditorService.removeDecorationType(variableTextDecorationType);
		this.codeEditorService.removeDecorationType(dynamicVariableDecorationType);
		this.codeEditorService.removeDecorationType(slashCommandTextDecorationType);

		const theme = this.themeService.getColorTheme();
		this.codeEditorService.registerDecorationType(decorationDescription, slashCommandTextDecorationType, {
			color: theme.getColor(chatSlashCommandForeground)?.toString(),
			backgroundColor: theme.getColor(chatSlashCommandBackground)?.toString(),
			borderRadius: '3px'
		});
		this.codeEditorService.registerDecorationType(decorationDescription, variableTextDecorationType, {
			color: theme.getColor(chatSlashCommandForeground)?.toString(),
			backgroundColor: theme.getColor(chatSlashCommandBackground)?.toString(),
			borderRadius: '3px'
		});
		this.codeEditorService.registerDecorationType(decorationDescription, dynamicVariableDecorationType, {
			color: theme.getColor(chatSlashCommandForeground)?.toString(),
			backgroundColor: theme.getColor(chatSlashCommandBackground)?.toString(),
			borderRadius: '3px'
		});
		this.updateInputEditorDecorations();
	}

	private getPlaceholderColor(): string | undefined {
		const theme = this.themeService.getColorTheme();
		const transparentForeground = theme.getColor(inputPlaceholderForeground);
		return transparentForeground?.toString();
	}

	private async updateInputEditorDecorations() {
		const inputValue = this.widget.inputEditor.getValue();

		const viewModel = this.widget.viewModel;
		if (!viewModel) {
			return;
		}

		// if (!inputValue) {
		const viewModelPlaceholder = this.widget.viewModel?.inputPlaceholder;
		const placeholder = viewModelPlaceholder ?? '';
		const decoration: IModelDeltaDecoration[] = [
			{
				range: {
					startLineNumber: 1,
					endLineNumber: 1,
					startColumn: 1,
					endColumn: 1000
				},
				options: {
					description: decorationDescription,
					after: {
						content: placeholder,
						inlineClassName: 'chat-input-placeholder'
					},
				}
			}
		];
		this.placeholderDecorations.set(decoration);
		return;
		// }

		// const parsedRequest = (await this.instantiationService.createInstance(ChatRequestParser).parseChatRequest(viewModel.sessionId, inputValue)).parts;

		// let placeholderDecoration: IModelDeltaDecoration[] | undefined;
		// const agentPart = parsedRequest.find((p): p is ChatRequestAgentPart => p instanceof ChatRequestAgentPart);
		// const agentSubcommandPart = parsedRequest.find((p): p is ChatRequestAgentSubcommandPart => p instanceof ChatRequestAgentSubcommandPart);
		// const slashCommandPart = parsedRequest.find((p): p is ChatRequestSlashCommandPart => p instanceof ChatRequestSlashCommandPart);

		// const exactlyOneSpaceAfterPart = (part: IParsedChatRequestPart): boolean => {
		// 	const partIdx = parsedRequest.indexOf(part);
		// 	if (parsedRequest.length > partIdx + 2) {
		// 		return false;
		// 	}

		// 	const nextPart = parsedRequest[partIdx + 1];
		// 	return nextPart && nextPart instanceof ChatRequestTextPart && nextPart.text === ' ';
		// };

		// const onlyAgentAndWhitespace = agentPart && parsedRequest.every(p => p instanceof ChatRequestTextPart && !p.text.trim().length || p instanceof ChatRequestAgentPart);
		// if (onlyAgentAndWhitespace) {
		// 	// Agent reference with no other text - show the placeholder
		// 	if (agentPart.agent.metadata.description && exactlyOneSpaceAfterPart(agentPart)) {
		// 		placeholderDecoration = [{
		// 			range: {
		// 				startLineNumber: agentPart.editorRange.startLineNumber,
		// 				endLineNumber: agentPart.editorRange.endLineNumber,
		// 				startColumn: agentPart.editorRange.endColumn + 1,
		// 				endColumn: 1000
		// 			},
		// 			options: {
		// 				description: decorationDescription,
		// 				after: {
		// 					content: agentPart.agent.metadata.description,
		// 					inlineClassName: 'chat-input-placeholder'
		// 				}
		// 			}
		// 		}];
		// 	}
		// }

		// const onlyAgentCommandAndWhitespace = agentPart && agentSubcommandPart && parsedRequest.every(p => p instanceof ChatRequestTextPart && !p.text.trim().length || p instanceof ChatRequestAgentPart || p instanceof ChatRequestAgentSubcommandPart);
		// if (onlyAgentCommandAndWhitespace) {
		// 	// Agent reference and subcommand with no other text - show the placeholder
		// 	const isFollowupSlashCommand = this.previouslyUsedAgents.has(agentAndCommandToKey(agentPart.agent.id, agentSubcommandPart.command.name));
		// 	const shouldRenderFollowupPlaceholder = isFollowupSlashCommand && agentSubcommandPart.command.followupPlaceholder;
		// 	if (agentSubcommandPart?.command.description && exactlyOneSpaceAfterPart(agentSubcommandPart)) {
		// 		placeholderDecoration = [{
		// 			range: {
		// 				startLineNumber: agentSubcommandPart.editorRange.startLineNumber,
		// 				endLineNumber: agentSubcommandPart.editorRange.endLineNumber,
		// 				startColumn: agentSubcommandPart.editorRange.endColumn + 1,
		// 				endColumn: 1000
		// 			},
		// 			options: {
		// 				description: decorationDescription,
		// 				after: {
		// 					content: (shouldRenderFollowupPlaceholder ? agentSubcommandPart.command.followupPlaceholder : agentSubcommandPart.command.description) ?? '',
		// 					inlineClassName: 'chat-input-placeholder'
		// 				}
		// 			}
		// 		}];
		// 	}
		// }

		// const onlySlashCommandAndWhitespace = slashCommandPart && parsedRequest.every(p => p instanceof ChatRequestTextPart && !p.text.trim().length || p instanceof ChatRequestSlashCommandPart);
		// if (onlySlashCommandAndWhitespace) {
		// 	// Command reference with no other text - show the placeholder
		// 	if (slashCommandPart.slashCommand.detail && exactlyOneSpaceAfterPart(slashCommandPart)) {
		// 		placeholderDecoration = [{
		// 			range: {
		// 				startLineNumber: slashCommandPart.editorRange.startLineNumber,
		// 				endLineNumber: slashCommandPart.editorRange.endLineNumber,
		// 				startColumn: slashCommandPart.editorRange.endColumn + 1,
		// 				endColumn: 1000
		// 			},
		// 			options: {
		// 				description: decorationDescription,
		// 				after: {
		// 					content: slashCommandPart.slashCommand.detail,
		// 					inlineClassName: 'chat-input-placeholder'
		// 				}
		// 			}
		// 		}];
		// 	}
		// }

		// // this.widget.inputEditor.setDecorationsByType(decorationDescription, placeholderDecorationType, placeholderDecoration ?? []);
		// // this.placeholderDecorations.set(placeholderDecoration ?? []);

		// const textDecorations: IDecorationOptions[] | undefined = [];
		// if (agentPart) {
		// 	textDecorations.push({ range: agentPart.editorRange });
		// 	if (agentSubcommandPart) {
		// 		textDecorations.push({ range: agentSubcommandPart.editorRange });
		// 	}
		// }

		// if (slashCommandPart) {
		// 	textDecorations.push({ range: slashCommandPart.editorRange });
		// }

		// // this.widget.inputEditor.setDecorationsByType(decorationDescription, slashCommandTextDecorationType, textDecorations);

		// const varDecorations: IDecorationOptions[] = [];
		// const variableParts = parsedRequest.filter((p): p is ChatRequestVariablePart => p instanceof ChatRequestVariablePart);
		// for (const variable of variableParts) {
		// 	varDecorations.push({ range: variable.editorRange });
		// }

		// this.widget.inputEditor.setDecorationsByType(decorationDescription, variableTextDecorationType, varDecorations);
	}
}

class InputEditorSlashCommandMode extends Disposable {
	public readonly id = 'InputEditorSlashCommandMode';

	constructor(
		private readonly widget: IChatWidget
	) {
		super();
		this._register(this.widget.onDidChangeAgent(e => {
			if (e.slashCommand && e.slashCommand.isSticky || !e.slashCommand && e.agent.metadata.isSticky) {
				this.repopulateAgentCommand(e.agent, e.slashCommand);
			}
		}));
		this._register(this.widget.onDidSubmitAgent(e => {
			this.repopulateAgentCommand(e.agent, e.slashCommand);
		}));
	}

	private async repopulateAgentCommand(agent: IChatAgentData, slashCommand: IChatAgentCommand | undefined) {
		// Make sure we don't repopulate if the user already has something in the input
		if (this.widget.inputEditor.getValue().trim()) {
			return;
		}

		let value: string | undefined;
		if (slashCommand && slashCommand.isSticky) {
			value = `${chatAgentLeader}${agent.name} ${chatSubcommandLeader}${slashCommand.name} `;
		} else if (agent.metadata.isSticky) {
			value = `${chatAgentLeader}${agent.name} `;
		}

		if (value) {
			this.widget.inputEditor.setValue(value);
			this.widget.inputEditor.setPosition({ lineNumber: 1, column: value.length + 1 });
		}
	}
}

ChatWidget.CONTRIBS.push(InputEditorDecorations, InputEditorSlashCommandMode);

class ChatTokenDeleter extends Disposable {

	public readonly id = 'chatTokenDeleter';

	constructor(
		private readonly widget: IChatWidget,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		const parser = this.instantiationService.createInstance(ChatRequestParser);
		const inputValue = this.widget.inputEditor.getValue();
		let previousInputValue: string | undefined;
		let previousSelectedAgent: IChatAgentData | undefined;

		// A simple heuristic to delete the previous token when the user presses backspace.
		// The sophisticated way to do this would be to have a parse tree that can be updated incrementally.
		this._register(this.widget.inputEditor.onDidChangeModelContent(e => {
			if (!previousInputValue) {
				previousInputValue = inputValue;
				previousSelectedAgent = this.widget.lastSelectedAgent;
			}

			// Don't try to handle multicursor edits right now
			const change = e.changes[0];

			// If this was a simple delete, try to find out whether it was inside a token
			if (!change.text && this.widget.viewModel) {
				const previousParsedValue = parser.parseChatRequest(this.widget.viewModel.sessionId, previousInputValue, widget.location, { selectedAgent: previousSelectedAgent, mode: this.widget.input.currentMode });

				// For dynamic variables, this has to happen in ChatDynamicVariableModel with the other bookkeeping
				const deletableTokens = previousParsedValue.parts.filter(p => p instanceof ChatRequestAgentPart || p instanceof ChatRequestAgentSubcommandPart || p instanceof ChatRequestSlashCommandPart || p instanceof ChatRequestToolPart);
				deletableTokens.forEach(token => {
					const deletedRangeOfToken = Range.intersectRanges(token.editorRange, change.range);
					// Part of this token was deleted, or the space after it was deleted, and the deletion range doesn't go off the front of the token, for simpler math
					if (deletedRangeOfToken && Range.compareRangesUsingStarts(token.editorRange, change.range) < 0) {
						// Assume single line tokens
						const length = deletedRangeOfToken.endColumn - deletedRangeOfToken.startColumn;
						const rangeToDelete = new Range(token.editorRange.startLineNumber, token.editorRange.startColumn, token.editorRange.endLineNumber, token.editorRange.endColumn - length);
						this.widget.inputEditor.executeEdits(this.id, [{
							range: rangeToDelete,
							text: '',
						}]);
						this.widget.refreshParsedInput();
					}
				});
			}

			previousInputValue = this.widget.inputEditor.getValue();
			previousSelectedAgent = this.widget.lastSelectedAgent;
		}));
	}
}
ChatWidget.CONTRIBS.push(ChatTokenDeleter);
