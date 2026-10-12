"""perpetual tasks: an aim its team works on without stopping, paced by pressure

Revision ID: e6a8c0d2f4b5
Revises: d5f7b9c1e3a4
Create Date: 2026-10-12 23:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'e6a8c0d2f4b5'
down_revision: Union[str, Sequence[str], None] = 'd5f7b9c1e3a4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

JSON = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql')


def upgrade() -> None:
    op.create_table('perpetual_tasks',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('aim_id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False, server_default='running'),
    sa.Column('phase', sa.String(length=16), nullable=False, server_default='starting'),
    sa.Column('phase_note', sa.Text(), nullable=False, server_default=''),
    sa.Column('phase_since', sa.DateTime(timezone=True), nullable=True),
    sa.Column('next_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('pressure', sa.Float(), nullable=False, server_default='0.5'),
    sa.Column('parts', JSON, nullable=False, server_default='{}'),
    sa.Column('ledger', JSON, nullable=False, server_default='[]'),
    sa.Column('work_s', sa.Float(), nullable=False, server_default='0'),
    sa.Column('rest_s', sa.Float(), nullable=False, server_default='0'),
    sa.Column('pause_s', sa.Float(), nullable=False, server_default='0'),
    sa.Column('cycles', sa.Integer(), nullable=False, server_default='0'),
    sa.Column('settings', JSON, nullable=False, server_default='{}'),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['aim_id'], ['aims.id'], name=op.f('fk_perpetual_tasks_aim_id_aims'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_perpetual_tasks_project_id_projects'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_perpetual_tasks_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_perpetual_tasks')),
    sa.UniqueConstraint('aim_id', name=op.f('uq_perpetual_tasks_aim_id'))
    )


def downgrade() -> None:
    op.drop_table('perpetual_tasks')
