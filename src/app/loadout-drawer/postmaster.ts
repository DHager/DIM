import { t } from 'app/i18next-t';
import { postmasterNotification } from 'app/inventory/MoveNotifications';
import { storesSelector } from 'app/inventory/selectors';
import {
  capacityForItem,
  findItemsByBucket,
  getVault,
  spaceLeftForItem,
} from 'app/inventory/stores-helpers';
import { ThunkResult } from 'app/store/types';
import { CanceledError, CancelToken, withCancel } from 'app/utils/cancel';
import { DimError } from 'app/utils/dim-error';
import { errorLog } from 'app/utils/log';
import { BucketHashes } from 'data/d2/generated-enums';
import _ from 'lodash';
import { InventoryBuckets } from '../inventory/inventory-buckets';
import { executeMoveItem, MoveReservations } from '../inventory/item-move-service';
import { DimItem } from '../inventory/item-types';
import { DimStore } from '../inventory/store-types';
import { showNotification } from '../notifications/notifications';

export function makeRoomForPostmaster(store: DimStore, buckets: InventoryBuckets): ThunkResult {
  return async (dispatch) => {
    const postmasterItems: DimItem[] = buckets.byCategory.Postmaster.flatMap((bucket) =>
      findItemsByBucket(store, bucket.hash)
    );
    const postmasterItemCountsByType = _.countBy(postmasterItems, (i) => i.bucket.hash);

    const [cancelToken, cancel] = withCancel();

    // If any category is full, we'll move enough aside
    const itemsToMove: DimItem[] = [];
    _.forIn(postmasterItemCountsByType, (count, bucket) => {
      const bucketHash = parseInt(bucket, 10);
      if (count > 0 && findItemsByBucket(store, bucketHash).length > 0) {
        const items: DimItem[] = findItemsByBucket(store, bucketHash);
        const capacity = capacityForItem(store, items[0]);
        const numNeededToMove = Math.max(0, count + items.length - capacity);
        if (numNeededToMove > 0) {
          // We'll move the lowest-value item to the vault.
          const candidates = _.sortBy(
            items.filter((i) => !i.equipped && !i.notransfer),
            (i) => {
              let value = {
                Common: 0,
                Uncommon: 1,
                Rare: 2,
                Legendary: 3,
                Exotic: 4,
                Currency: 5,
                Unknown: 6,
              }[i.tier];
              // And low-stat
              if (i.primStat) {
                value += i.primStat.value / 1000;
              }
              return value;
            }
          );
          itemsToMove.push(..._.take(candidates, numNeededToMove));
        }
      }
    });
    try {
      await dispatch(moveItemsToVault(store, itemsToMove, cancelToken));
      showNotification({
        type: 'success',
        title: t('Loadouts.MakeRoom'),
        body: t('Loadouts.MakeRoomDone', {
          count: postmasterItems.length,
          movedNum: itemsToMove.length,
          store: store.name,
          context: store.genderName,
        }),
        onCancel: cancel,
      });
    } catch (e) {
      if (!(e instanceof CanceledError)) {
        showNotification({
          type: 'error',
          title: t('Loadouts.MakeRoom'),
          body: t('Loadouts.MakeRoomError', { error: e.message }),
        });
        throw e;
      }
    }
  };
}

// D2 only
export function pullablePostmasterItems(store: DimStore, stores: DimStore[]) {
  return (findItemsByBucket(store, BucketHashes.LostItems) || []).filter((i) =>
    canBePulledFromPostmaster(i, store, stores)
  );
}

/**
 * Can the given item be pulled from postmaster into a store?
 */
export function canBePulledFromPostmaster(i: DimItem, store: DimStore, stores: DimStore[]) {
  return (
    i.canPullFromPostmaster && // Can be pulled
    // Either has space, or is going to a bucket we can make room in
    ((i.bucket.vaultBucket && !i.notransfer) || spaceLeftForItem(store, i, stores) > 0)
  );
}

// We should load this from the manifest but it's hard to get it in here
export const POSTMASTER_SIZE = 21;

export function postmasterAlmostFull(store: DimStore) {
  return postmasterSpaceLeft(store) < 6; // I think you can get 6 drops at once in some activities
}

export function postmasterSpaceLeft(store: DimStore) {
  return Math.max(0, POSTMASTER_SIZE - totalPostmasterItems(store));
}
export function postmasterSpaceUsed(store: DimStore) {
  return POSTMASTER_SIZE - postmasterSpaceLeft(store);
}

export function totalPostmasterItems(store: DimStore) {
  return findItemsByBucket(store, BucketHashes.LostItems).length;
}

const showNoSpaceError = _.throttle(
  (e: Error) =>
    showNotification({
      type: 'error',
      title: t('Loadouts.PullFromPostmasterPopupTitle'),
      body: t('Loadouts.NoSpace', { error: e.message }),
    }),
  1000,
  { leading: true, trailing: false }
);

// D2 only
export function pullFromPostmaster(store: DimStore): ThunkResult {
  return async (dispatch, getState) => {
    const stores = storesSelector(getState());
    const items = pullablePostmasterItems(store, stores);

    // Only show one popup per message
    const errorNotification = _.memoize((message: string) => {
      showNotification({
        type: 'error',
        title: t('Loadouts.PullFromPostmasterPopupTitle'),
        body: t('Loadouts.PullFromPostmasterError', { error: message }),
      });
    });

    const [cancelToken, cancel] = withCancel();

    const promise = (async () => {
      let succeeded = 0;

      for (const item of items) {
        let amount = item.amount;
        if (item.uniqueStack) {
          const spaceLeft = spaceLeftForItem(store, item, storesSelector(getState()));
          if (spaceLeft > 0) {
            // Only transfer enough to top off the stack
            amount = Math.min(item.amount || 1, spaceLeft);
          }
          // otherwise try the move anyway - it may be that you don't have any but your bucket
          // is full, so it'll move aside something else (or the stack itself can be moved into
          // the vault). Otherwise it'll fail in moveTo.
        }

        try {
          await dispatch(executeMoveItem(item, store, { equip: false, amount, cancelToken }));
          succeeded++;
        } catch (e) {
          if (e instanceof CanceledError) {
            return false;
          }
          // TODO: collect and summarize errors?
          errorLog('postmaster', `Error pulling ${item.name} from postmaster`, e);
          if (e instanceof DimError && e.code === 'no-space') {
            if (items.length === 1) {
              // Transform the notification into an error
              throw new Error(t('Loadouts.NoSpace', { error: e.message }));
            } else {
              // Show the error separately and continue
              showNoSpaceError(e);
            }
          } else {
            if (items.length === 1) {
              // Transform the notification into an error
              throw new Error(t('Loadouts.PullFromPostmasterError', { error: e.message }));
            } else {
              // Show the error separately and continue
              errorNotification(e.message);
            }
          }
        }
      }

      if (!succeeded) {
        throw new Error(t('Loadouts.PullFromPostmasterGeneralError'));
      }
    })();

    showNotification(postmasterNotification(items.length, store, promise, cancel));

    await promise;
  };
}

// cribbed from D1FarmingService, but modified
function moveItemsToVault(
  store: DimStore,
  items: DimItem[],
  cancelToken: CancelToken
): ThunkResult {
  return async (dispatch, getState) => {
    const reservations: MoveReservations = {};
    // reserve space for all move-asides
    reservations[store.id] = _.countBy(items, (i) => i.type);

    for (const item of items) {
      const stores = storesSelector(getState());
      // Move a single item. We reevaluate the vault each time in case things have changed.
      const vault = getVault(stores)!;
      const vaultSpaceLeft = spaceLeftForItem(vault, item, stores);
      if (vaultSpaceLeft <= 1) {
        // If we're down to one space, try putting it on other characters
        const otherStores = stores.filter((s) => !s.isVault && s.id !== store.id);
        const otherStoresWithSpace = otherStores.filter((store) =>
          spaceLeftForItem(store, item, stores)
        );

        if (otherStoresWithSpace.length) {
          await dispatch(
            executeMoveItem(item, otherStoresWithSpace[0], {
              equip: false,
              amount: item.amount,
              excludes: items,
              reservations,
              cancelToken,
            })
          );
          continue;
        }
      }
      await dispatch(
        executeMoveItem(item, vault, {
          equip: false,
          amount: item.amount,
          excludes: items,
          reservations,
          cancelToken,
        })
      );
    }
  };
}
