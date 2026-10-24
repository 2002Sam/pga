"""做梦: dreams — what PGA saw looking back over your conversations, and the tidying it proposes (pga.dream)

Revision ID: e9b1d3f5a7c8
Revises: d5f7b9c1e3a6
Create Date: 2026-10-24 05:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'e9b1d3f5a7c8'
down_revision: Union[str, Sequence[str], None] = 'd5f7b9c1e3a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        'dreams',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('narrative', sa.Text(), nullable=False),
        sa.Column('seeds', J, nullable=False),
        sa.Column('recalled', J, nullable=False),
        sa.Column('ops', J, nullable=False),
        sa.Column('status', sa.String(length=12), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_dreams_user_id', 'dreams', ['user_id'])


def downgrade() -> None:
    op.drop_index('ix_dreams_user_id', table_name='dreams')
    op.drop_table('dreams')
