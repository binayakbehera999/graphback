import { graphQLInputContext, InputModelTypeContext, OBJECT_TYPE_DEFINITION } from '@graphback/core';
import { diff } from '@graphql-inspector/core';
import { buildSchema, GraphQLSchema, printSchema } from 'graphql';
import * as knex from 'knex';
import { KnexMigrationProvider, LocalMigrationManager } from '.';
import { removeDirectivesFromSchema } from '../../util/removeDirectivesFromSchema';
import { ModelChange, ModelChangeType } from '../changes/ChangeTypes';
import { DatabaseChange, DatabaseChangeType, DatabaseInitializationStrategy } from '../database';
import { mapModelChanges } from '../util/mapModelChanges';
import { KnexMigrationManager } from './KnexMigrationManager';
import { MigrationProvider } from './MigrationProvider';
import { SchemaMigration } from './SchemaMigration';
import { getChanges } from './utils';

export async function migrateDBUsingSchema(schemaText: string, strategy: DatabaseInitializationStrategy) {
  const changes = await strategy.init(schemaText);
  return changes;
}
/**
 * Manages schema migration.
 *
 * - Create migration tables
 * - Generate migrations
 * - Apply migrations
 *
 * @export
 * @class GraphQLMigrationCreator
 */
export class GraphQLMigrationCreator {
  private schema: GraphQLSchema;
  private knexMigrationManager: KnexMigrationManager;
  private localMigrationManager: LocalMigrationManager;
  private migrationProvider: MigrationProvider;
  private inputContext: InputModelTypeContext[];
  // tslint:disable-next-line: no-any
  constructor(schemaText: string, db: knex<any, unknown[]>, migrationsDir: string) {
    this.schema = removeDirectivesFromSchema(schemaText);
    this.inputContext = graphQLInputContext.createModelContext(schemaText, {});
    this.migrationProvider = new KnexMigrationProvider(db, migrationsDir);
    this.knexMigrationManager = new KnexMigrationManager(db);
    this.localMigrationManager = new LocalMigrationManager(migrationsDir);
  }

  /**
   * Initialize the schema migration process.
   *
   * @memberof GraphQLMigrationCreator
   */
  public async init(): Promise<string[]> {
    await this.createMetadataTables();

    const newMigration = await this.generateMigration();

    if (newMigration) {
      this.localMigrationManager.createMigration(newMigration);
      await this.knexMigrationManager.createMigration(newMigration);
    }

    const migrations = await this.knexMigrationManager.getMigrations();

    const appliedMigrations = await this.applyMigrations(migrations);

    const changes = getChanges(appliedMigrations);
    return changes;
  }

  /**
   * Collect migration metadata and create it
   *
   * @private
   * @returns
   * @memberof GraphQLMigrationCreator
   */
  public async generateMigration(): Promise<SchemaMigration> {

    const migrations = await this.migrationProvider.getMigrations();

    let oldSchema: GraphQLSchema;
    if (migrations.length) {
      const last = migrations[migrations.length - 1];

      oldSchema = buildSchema(last.model);
    }

    const newMigration: SchemaMigration = {
      id: new Date().getTime(),
      model: printSchema(this.schema)
    };

    let changes: ModelChange[] = [];
    if (oldSchema) {
      const inspectorChanges = diff(oldSchema, this.schema);
      changes = mapModelChanges(inspectorChanges);
    } else {
      changes = this.getContext().map((model: InputModelTypeContext) => {
        return {
          type: ModelChangeType.TYPE_ADDED,
          path: {
            type: model.name
          }
        }
      });
    }

    if (!changes.length) {
      return undefined;
    }

    newMigration.sql_up = this.getSqlStatements(changes).map((d: DatabaseChange) => d.sql).join('\n\n');
    newMigration.changes = JSON.stringify(changes);

    return newMigration;
  }

  public async createMetadataTables() {
    await this.knexMigrationManager.createMetadataTables();
  }

  /**
   * Get the migrations that have not been applied and apply them
   *
   * @private
   * @memberof GraphQLMigrationCreator
   */
  private async applyMigrations(migrations: SchemaMigration[]): Promise<SchemaMigration[]> {
    const migrationsToApply = migrations.filter((m: SchemaMigration) => !m.applied_at);

    const sorted = migrationsToApply.sort((a: SchemaMigration, b: SchemaMigration) => {
      return Number(a.id) - Number(b.id);
    });

    for (const migration of sorted) {
      await this.migrationProvider.applyMigration(migration);
    }

    return migrationsToApply;
  }

  /**
   * Group all chage types by their model
   *
   * @private
   * @param {ModelChange[]} changes
   * @returns
   * @memberof GraphQLMigrationCreator
   */
  private groupChangesByModel(changes: ModelChange[]) {
    return changes.reduce((acc: ModelChange, current: ModelChange) => {

      if (!acc[current.path.type]) {
        acc[current.path.type] = [];
      }
      acc[current.path.type].push(current);

      return acc;
      // tslint:disable-next-line: no-object-literal-type-assertion
    }, {} as ModelChange);
  }

  /**
   * Generate CREATE and ALTER SQL statements
   *
   * @private
   * @param {ModelChange[]} changes
   * @returns {DatabaseChange[]}
   * @memberof GraphQLMigrationCreator
   */
  private getSqlStatements(changes: ModelChange[]): DatabaseChange[] {
    const groupedChanges = this.groupChangesByModel(changes);
    const dirtyModels = this.getContext().filter((t: InputModelTypeContext) => {
      return !!groupedChanges[t.name];
    });

    return dirtyModels.map((t: InputModelTypeContext) => {
      const modelChangeTypes: ModelChange[] = groupedChanges[t.name];

      const typeAdded = modelChangeTypes.find((c: ModelChange) => c.type === ModelChangeType.TYPE_ADDED);

      if (typeAdded) {
        return {
          type: DatabaseChangeType.createTable,
          sql: this.knexMigrationManager.addTable(t)
        }
      } else {
        return {
          type: DatabaseChangeType.alterTable,
          sql: this.knexMigrationManager.alterTable(t, modelChangeTypes)
        }
      }
    });
  }

  private getContext(): InputModelTypeContext[] {
    return this.inputContext.filter((t: InputModelTypeContext) => t.kind === OBJECT_TYPE_DEFINITION && t.name !== 'Query' && t.name !== 'Mutation' && t.name !== 'Subscription');
  }
}
