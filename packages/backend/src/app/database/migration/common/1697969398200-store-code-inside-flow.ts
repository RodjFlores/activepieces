import { MigrationInterface, QueryRunner } from 'typeorm'
import { logger } from '../../../helper/logger'
import { isNil } from '@activepieces/shared'
import decompress from 'decompress'

type FunctionTransformer = (s: CodeStep, fileRepo: QueryRunner, flowId: string, flowVersionId: string) => Promise<void>

export class StoreCodeInsideFlow1697969398200 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.processFlowVersions(queryRunner, flattenCodeStep)
        await this.processFlowTemplates(queryRunner, flattenCodeStep)

        logger.info('StoreCodeInsideFlow1697969398200: up finished')
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await this.processFlowVersions(queryRunner, removeNewCodeField)
        await this.processFlowTemplates(queryRunner, removeNewCodeField)

        logger.info('StoreCodeInsideFlow1697969398200: down finished')
    }

    private async processFlowVersions(queryRunner: QueryRunner, stepFunction: FunctionTransformer) {
        const flowVersionRepo = queryRunner.connection.getRepository<FlowVersion>('flow_version')
        const flowVersionIds = await queryRunner.query('SELECT id FROM flow_version')

        for (const { id } of flowVersionIds) {
            const flowVersion = await flowVersionRepo.findOneBy({ id })

            if (flowVersion) {
                const updated = await traverseAndUpdateSubFlow(stepFunction, flowVersion.trigger, queryRunner, flowVersion.flowId, flowVersion.id)

                if (updated) {
                    await flowVersionRepo.update(flowVersion.id, flowVersion)
                }
            }
        }
    }

    private async processFlowTemplates(queryRunner: QueryRunner, stepFunction: FunctionTransformer) {
        // Check if the "flow_template" table exists
        const doesTableExist = await queryRunner.hasTable('flow_template')

        if (doesTableExist) {
            logger.info('StoreCodeInsideFlow1697969398200: flow template table exists')

            const templates = await queryRunner.query('SELECT * FROM flow_template')
            for (const template of templates) {
                const updated = await traverseAndUpdateSubFlow(stepFunction, template.template.trigger, queryRunner, template.projectId, template.id)

                if (updated) {
                    await queryRunner.query('UPDATE flow_template SET template = ? WHERE id = ?', [template.template, template.id])
                }
            }
        }
    }
}

const traverseAndUpdateSubFlow = async (updater: FunctionTransformer, root: Step | undefined, queryRunner: QueryRunner, flowId: string, flowVersionId: string): Promise<boolean> => {
    if (!root) {
        return false
    }

    let updated = false

    switch (root.type) {
        case 'BRANCH':
            updated = await traverseAndUpdateSubFlow(updater, root.onSuccessAction, queryRunner, flowId, flowVersionId) || updated
            updated = await traverseAndUpdateSubFlow(updater, root.onFailureAction, queryRunner, flowId, flowVersionId) || updated
            break
        case 'LOOP_ON_ITEMS':
            updated = await traverseAndUpdateSubFlow(updater, root.firstLoopAction, queryRunner, flowId, flowVersionId) || updated
            break
        case 'CODE':
            await updater(root, queryRunner, flowId, flowVersionId)
            updated = true
            break
        default:
            break
    }

    updated = await traverseAndUpdateSubFlow(updater, root.nextAction, queryRunner, flowId, flowVersionId) || updated
    return updated
}

const flattenCodeStep = async (codeStep: CodeStep, queryRunner: QueryRunner, flowVersionId: string, flowId: string): Promise<void> => {
    const sourceCodeId = codeStep.settings.artifactSourceId
    const sourceCode = codeStep.settings.sourceCode
    if (!isNil(sourceCodeId) && isNil(sourceCode)) {
        const [file] = await queryRunner.query('SELECT * FROM file WHERE id = ? LIMIT 1', [sourceCodeId])
        if (isNil(file)) {
            logger.warn(`StoreCodeInsideFlow1697969398100: file not found for file id ${sourceCodeId} in flow ${flowId} of flow version ${flowVersionId}`)
            return
        }
        const buffer = await decompress(file.data)
        const code = buffer.find((f: { path: string | string[] }) => f.path.includes('index.ts') || f.path.includes('index.js'))
        const packageJson = buffer.find((f: { path: string | string[] }) => f.path.includes('package.json'))
        if (isNil(code) || isNil(packageJson)) {
            logger.warn(`StoreCodeInsideFlow1697969398100: code or package.json not found for file ${file.id} in flow ${flowId} of flow version ${flowVersionId}`)
            return
        }
        codeStep.settings.sourceCode = {
            code: code.data.toString('utf-8'),
            packageJson: packageJson.data.toString('utf-8'),
        }
    }
}

const removeNewCodeField = async (codeStep: CodeStep, _queryRunner: QueryRunner): Promise<void> => {
    delete codeStep.settings.sourceCode
}


type StepType =
    | 'BRANCH'
    | 'CODE'
    | 'EMPTY'
    | 'LOOP_ON_ITEMS'
    | 'MISSING'
    | 'PIECE'
    | 'PIECE_TRIGGER'
    | 'WEBHOOK'

type BaseStep<T extends StepType> = {
    type: T
    nextAction?: Step
}

type BranchStep = BaseStep<'BRANCH'> & {
    onFailureAction?: Step
    onSuccessAction?: Step
}

type LoopOnItemsStep = BaseStep<'LOOP_ON_ITEMS'> & {
    firstLoopAction?: Step
}

type CodeStep = BaseStep<'CODE'> & {
    settings: {
        artifactSourceId: string
        sourceCode?: {
            code: string
            packageJson: string
        }
    }
}

type GenericStep = BaseStep<'PIECE' | 'PIECE_TRIGGER' | 'EMPTY' | 'MISSING' | 'WEBHOOK'>

type Step =
    | BranchStep
    | LoopOnItemsStep
    | GenericStep
    | CodeStep

type FlowVersion = {
    id: string
    flowId: string
    trigger?: Step
}
