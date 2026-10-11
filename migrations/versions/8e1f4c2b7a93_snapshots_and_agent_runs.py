"""snapshots (stop/resume) and agent_runs (the agent pool)

Revision ID: 8e1f4c2b7a93
Revises: 5b9e3f1a2c70
Create Date: 2026-10-11 12:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '8e1f4c2b7a93'
down_revision: Union[str, Sequence[str], None] = '5b9e3f1a2c70'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('snapshots',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('worker_id', sa.String(length=128), nullable=False),
    sa.Column('at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('data', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_snapshots'))
    )
    op.create_index('ix_snapshots_at', 'snapshots', ['at'], unique=False)
    op.create_table('agent_runs',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=True),
    sa.Column('parent_id', sa.Uuid(), nullable=True),
    sa.Column('job_id', sa.Uuid(), nullable=True),
    sa.Column('workflow', sa.String(length=40), nullable=False),
    sa.Column('pattern', sa.String(length=16), nullable=False),
    sa.Column('step', sa.String(length=24), nullable=False),
    sa.Column('agent', sa.String(length=64), nullable=False),
    sa.Column('adapter', sa.String(length=32), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('prompt', sa.Text(), nullable=False),
    sa.Column('output', sa.Text(), nullable=False),
    sa.Column('data', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('workspace', sa.Text(), nullable=True),
    sa.Column('cost_usd', sa.Float(), nullable=True),
    sa.Column('duration_s', sa.Float(), nullable=False),
    sa.Column('attempt', sa.Integer(), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], name=op.f('fk_agent_runs_job_id_jobs'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['parent_id'], ['agent_runs.id'], name=op.f('fk_agent_runs_parent_id_agent_runs'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_agent_runs_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_agent_runs'))
    )
    op.create_index('ix_agent_runs_user_time', 'agent_runs', ['user_id', 'started_at'], unique=False)
    op.create_index('ix_agent_runs_parent', 'agent_runs', ['parent_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_agent_runs_parent', table_name='agent_runs')
    op.drop_index('ix_agent_runs_user_time', table_name='agent_runs')
    op.drop_table('agent_runs')
    op.drop_index('ix_snapshots_at', table_name='snapshots')
    op.drop_table('snapshots')
